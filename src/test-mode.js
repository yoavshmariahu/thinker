// One switch for test/benchmark side-effect isolation. Read dynamically so a
// focused test can exercise a feature with its own stub or temporary home.
export const isTestMode = (env = process.env) => env.THINKER_TEST === '1';
