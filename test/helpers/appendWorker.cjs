// NB13 test 4.8's second appender: a process that loads fileBackend (bundled from src by the test) and appends
// `count` unique lines to one path in batches of several lines, each batch one queued entry.
// Usage: node appendWorker.cjs <bundle.cjs> <file> <tag> <count>
const [bundle, file, tag, count] = process.argv.slice(2);
const fileBackend = require(bundle);

async function main() {
  const total = Number(count);
  for (let i = 0; i < total;) {
    const size = 1 + (i % 7);
    for (let j = 0; j < size && i < total; j++, i++) fileBackend.enqueueAppend(file, `${JSON.stringify({ tag, i })}\n`);
    await fileBackend.flushAll();
  }
  await fileBackend.flushAll();
}

main().then(() => process.exit(0), error => {
  console.error('[appendWorker] failed:', error);
  process.exit(1);
});
