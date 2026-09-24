'use strict';

/**
 * Opt-in Portkey benchmark: gemini-3.7-flash vs gemini-3.8-flash at thinking=low.
 *
 * Usage:
 *   PORTKEY_API_KEY=... node scripts/benchmark-models.js
 * Optional:
 *   PORTKEY_PROVIDER=@vertex   (default; use your Portkey integration slug)
 *   BENCHMARK_RUNS=3
 *
 * Never logs the API key. Writes aggregate metrics to cache/benchmarks/.
 */

const fs = require('fs');
const path = require('path');
const PortkeyModule = require('portkey-ai');
const Portkey = PortkeyModule.default || PortkeyModule.Portkey || PortkeyModule;

const MODELS = ['gemini-3.7-flash', 'gemini-3.8-flash'];
const THINKING_LEVEL = 'low';
const RUNS = Math.max(1, Number.parseInt(process.env.BENCHMARK_RUNS || '3', 10) || 3);

const PROMPTS = [
  {
    id: 'short-answer',
    text: 'In one sentence, what is the CAP theorem?'
  },
  {
    id: 'coding',
    text: 'Write a Python function that returns the nth Fibonacci number iteratively. Keep it under 15 lines.'
  },
  {
    id: 'summarization',
    text: 'Summarize in 3 bullets: an interview discussed React hooks, system design for a URL shortener, and a behavioral story about conflict resolution.'
  }
];

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    p95: percentile(sorted, 95),
    mean: sorted.length ? Math.round(sum / sorted.length) : null,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeBenchmarkError(value, sensitiveValues = []) {
  let text = String(value || 'benchmark run failed');

  for (const sensitiveValue of sensitiveValues) {
    const secret = String(sensitiveValue || '');
    if (secret) {
      text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    }
  }

  return text
    .replace(/\bAIza[0-9A-Za-z_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bsk-(?:proj-)?[0-9A-Za-z_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:pk|pkey)[-_][0-9A-Za-z_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[0-9A-Za-z._~+/-]{8,}=*\b/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[-_\s]?key|access[-_\s]?token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]'
    )
    .slice(0, 240);
}

function didBenchmarkSucceed(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((result) => (
      result?.ok === true
      && Number.isFinite(result.outputChars)
      && result.outputChars > 0
    ));
}

async function runOne(client, model, prompt) {
  const started = Date.now();
  let firstTokenAt = null;
  let text = '';
  let error = null;
  let usage = null;

  try {
    const stream = await client.chat.completions.create({
      model,
      stream: true,
      messages: [
        { role: 'system', content: 'You are a concise interview assistant. Be brief and accurate.' },
        { role: 'user', content: prompt.text }
      ],
      reasoning: { effort: THINKING_LEVEL },
      thinking: { type: 'enabled', budget_tokens: 256 }
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        if (firstTokenAt == null) {
          firstTokenAt = Date.now();
        }
        text += delta;
      }
      if (chunk?.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    error = String(err?.message || err);
  }

  const ended = Date.now();
  return {
    model,
    promptId: prompt.id,
    ok: !error && text.length > 0,
    error,
    ttftMs: firstTokenAt == null ? null : firstTokenAt - started,
    totalMs: ended - started,
    outputChars: text.length,
    usage
  };
}

async function main() {
  const apiKey = String(process.env.PORTKEY_API_KEY || '').trim();
  if (!apiKey) {
    console.error('PORTKEY_API_KEY is required. Export it in your shell; do not put it in source.');
    process.exitCode = 1;
    return;
  }

  const provider = String(process.env.PORTKEY_PROVIDER || '@vertex').trim();
  const client = new Portkey({
    apiKey,
    provider,
    strictOpenAiCompliance: false
  });

  const results = [];
  for (const model of MODELS) {
    for (const prompt of PROMPTS) {
      for (let run = 1; run <= RUNS; run += 1) {
        process.stdout.write(`Running ${model} / ${prompt.id} #${run}...\n`);
        // eslint-disable-next-line no-await-in-loop
        const rawResult = await runOne(client, model, prompt);
        const result = {
          ...rawResult,
          error: rawResult.error
            ? sanitizeBenchmarkError(rawResult.error, [apiKey])
            : null
        };
        results.push({ ...result, run });
        if (!result.ok) {
          process.stdout.write(`  FAIL: ${String(result.error || 'empty response').slice(0, 200)}\n`);
        } else {
          process.stdout.write(`  OK ttft=${result.ttftMs}ms total=${result.totalMs}ms chars=${result.outputChars}\n`);
        }
      }
    }
  }

  const byModel = {};
  for (const model of MODELS) {
    const modelResults = results.filter((entry) => entry.model === model);
    const okResults = modelResults.filter((entry) => entry.ok);
    const sampleErrors = [...new Set(
      modelResults
        .filter((entry) => entry.error)
        .map((entry) => String(entry.error).slice(0, 240))
    )].slice(0, 5);
    byModel[model] = {
      successCount: okResults.length,
      errorCount: modelResults.length - okResults.length,
      sampleErrors,
      ttft: summarize(okResults.map((entry) => entry.ttftMs).filter((value) => Number.isFinite(value))),
      total: summarize(okResults.map((entry) => entry.totalMs).filter((value) => Number.isFinite(value))),
      answerChecks: {
        nonEmpty: okResults.filter((entry) => entry.outputChars > 0).length,
        codingHasDef: results.filter((entry) => (
          entry.model === model
          && entry.promptId === 'coding'
          && entry.ok
          && entry.outputChars > 40
        )).length
      }
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    thinkingLevel: THINKING_LEVEL,
    runsPerPrompt: RUNS,
    provider,
    models: MODELS,
    byModel,
    recommendation: (() => {
      const left = byModel[MODELS[0]];
      const right = byModel[MODELS[1]];
      if (!left?.successCount && !right?.successCount) {
        return {
          model: null,
          reason: 'No successful runs. Check PORTKEY_PROVIDER (try @vertex) and that the Portkey integration can call Gemini 3.x.'
        };
      }
      if (!left?.successCount) {
        return { model: MODELS[1], reason: `${MODELS[0]} had no successes` };
      }
      if (!right?.successCount) {
        return { model: MODELS[0], reason: `${MODELS[1]} had no successes` };
      }
      const a = left.ttft?.median;
      const b = right.ttft?.median;
      if (a == null && b == null) return { model: null, reason: 'Missing TTFT medians' };
      if (a == null) return { model: MODELS[1], reason: 'Faster TTFT median' };
      if (b == null) return { model: MODELS[0], reason: 'Faster TTFT median' };
      const faster = a <= b ? MODELS[0] : MODELS[1];
      return {
        model: faster,
        reason: `Lower median TTFT (${faster === MODELS[0] ? a : b}ms vs ${faster === MODELS[0] ? b : a}ms) at thinking=${THINKING_LEVEL}`
      };
    })()
  };

  const outDir = path.join(__dirname, '..', 'cache', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `portkey-flash-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);

  if (!didBenchmarkSucceed(results)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Benchmark failed:', sanitizeBenchmarkError(error.message));
    process.exitCode = 1;
  });
}

module.exports = {
  didBenchmarkSucceed,
  main,
  runOne,
  sanitizeBenchmarkError,
  summarize
};
