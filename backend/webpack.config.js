// Separate entrypoints share source modules, never a running application context.
module.exports = (options) => ({
  ...options,
  entry: { main: options.entry, worker: './src/worker.ts', 'isolation-child': './src/isolation/isolation-child.ts' },
  output: { ...options.output, filename: '[name].js' },
});
