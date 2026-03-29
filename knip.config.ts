import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/server/cli.ts',
    'src/server/harness.ts',
    'src/server/harness-signal.ts',
    'src/server/watchdog.ts',
    'src/ui/index.ts',
    'scripts/*.mjs',
    'tests/**/*.spec.ts',
    'tests/**/*.test.ts',
  ],
  project: [
    'src/**/*.ts',
    'scripts/*.mjs',
    'tests/**/*.ts',
  ],
  ignore: [
    '.bobbit/config/**',
    'src/ui/speech-recognition.d.ts',
    'src/app/qrcode.d.ts',
  ],
  ignoreBinaries: ['tsx', 'report'],
  ignoreExportsUsedInFile: true,
  exclude: ['duplicates'],
  ignoreIssues: {
    'src/ui/components/GitStatusWidget.ts': ['exports'],
    'src/ui/components/ToolGroup.ts': ['exports'],
    'src/ui/tools/renderers/GateVerificationLive.ts': ['exports'],
  },
};

export default config;
