const { context, metrics, SpanStatusCode, trace } = require("@opentelemetry/api");
const { logs } = require("@opentelemetry/api-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { PrometheusExporter } = require("@opentelemetry/exporter-prometheus");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { NodeSDK } = require("@opentelemetry/sdk-node");

let sdk;
let toolkit;
let startupPromise;

function buildToolkit(serviceName) {
  const meter = metrics.getMeter(serviceName);
  const tracer = trace.getTracer(serviceName);
  const otelLogger = logs.getLogger(serviceName);

  const requestCounter = meter.createCounter("nekocafe_http_server_requests", {
    description: "Total number of HTTP requests served.",
  });
  const requestDuration = meter.createHistogram("nekocafe_http_server_duration_ms", {
    description: "HTTP request duration in milliseconds.",
    unit: "ms",
  });
  const activeRequests = meter.createUpDownCounter("nekocafe_http_server_active_requests", {
    description: "Number of in-flight HTTP requests.",
  });
  const processMemoryGauge = meter.createObservableGauge("nekocafe_process_memory_rss_bytes", {
    description: "Resident set size memory used by the Node.js process.",
    unit: "By",
  });

  processMemoryGauge.addCallback((result) => {
    result.observe(process.memoryUsage().rss, {
      service_name: serviceName,
      release_channel: process.env.RELEASE_CHANNEL || "stable",
      service_version: process.env.SERVICE_VERSION || "dev",
    });
  });

  function emitLog(severityText, body, attributes = {}) {
    otelLogger.emit({
      severityText,
      body,
      attributes,
    });
  }

  return {
    tracer,
    requestCounter,
    requestDuration,
    activeRequests,
    emitLog,
  };
}

function createFallbackToolkit(serviceName) {
  return buildToolkit(serviceName);
}

async function startTelemetry(serviceName) {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    toolkit = createFallbackToolkit(serviceName);
    return toolkit;
  }

  if (startupPromise) {
    return startupPromise;
  }

  startupPromise = (async () => {
    const prometheusPort = Number.parseInt(process.env.OTEL_PROMETHEUS_PORT || "9464", 10);
    const baseOtlpUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
    const traceUrl = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${baseOtlpUrl}/v1/traces`;
    const logsUrl = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${baseOtlpUrl}/v1/logs`;

    sdk = new NodeSDK({
      metricReader: new PrometheusExporter({
        host: "0.0.0.0",
        port: prometheusPort,
      }),
      logRecordProcessors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: logsUrl,
          })
        ),
      ],
      traceExporter: new OTLPTraceExporter({
        url: traceUrl,
      }),
    });

    await sdk.start();
    toolkit = buildToolkit(serviceName);
    toolkit.emitLog("INFO", "telemetry initialized", {
      service_name: serviceName,
      release_channel: process.env.RELEASE_CHANNEL || "stable",
      version: process.env.SERVICE_VERSION || "dev",
    });
    return toolkit;
  })();

  return startupPromise;
}

async function shutdownTelemetry() {
  await Promise.allSettled([sdk?.shutdown ? sdk.shutdown() : Promise.resolve()]);
}

function getToolkit(serviceName) {
  if (!toolkit) {
    toolkit = createFallbackToolkit(serviceName);
  }
  return toolkit;
}

function startRequestSpan(telemetry, serviceName, req) {
  const span = telemetry.tracer.startSpan(`${req.method} ${req.path}`, {
    attributes: {
      "service.name": serviceName,
      "http.method": req.method,
      "http.target": req.originalUrl,
      "release.channel": process.env.RELEASE_CHANNEL || "stable",
    },
  });
  return {
    span,
    activeContext: trace.setSpan(context.active(), span),
  };
}

function finishRequestSpan({ span }, statusCode, route, durationMs) {
  span.setAttribute("http.route", route);
  span.setAttribute("http.status_code", statusCode);
  span.setAttribute("http.response.duration_ms", durationMs);

  if (statusCode >= 500) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
    });
  }

  span.end();
}

module.exports = {
  context,
  finishRequestSpan,
  getToolkit,
  shutdownTelemetry,
  startRequestSpan,
  startTelemetry,
};
