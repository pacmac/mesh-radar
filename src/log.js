// Minimal levelled logger. Set LOG_LEVEL=debug in environment to see all output.
// Levels: error=0, warn=1, info=2, debug=3

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function make(level, fn) {
  const n = LEVELS[level];
  return (tag, ...args) => {
    if (n > MAX) return;
    fn(`${ts()} ${level.toUpperCase().padEnd(5)} [${tag}]`, ...args);
  };
}

export const log = {
  error: make('error', console.error),
  warn:  make('warn',  console.warn),
  info:  make('info',  console.log),
  debug: make('debug', console.log),
};
