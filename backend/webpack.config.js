// Separate entrypoints share source modules, never a running application context.
module.exports = (options) => ({
  ...options,
  entry: { main: options.entry, worker: './src/worker.ts' },
  output: { ...options.output, filename: '[name].js' },
});
