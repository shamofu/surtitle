import { fileURLToPath } from 'node:url';

export const hooks = {
  updateConfig(config) {
    const extraEnv = { ...config.extraEnv };
    if (![process.env, extraEnv].some(env => env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR)) {
      extraEnv.CARGO_TARGET_DIR = fileURLToPath(new URL('./work/target', import.meta.url));
    }
    return { ...config, extraEnv };
  },
};
