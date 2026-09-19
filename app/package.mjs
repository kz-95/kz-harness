// Builds app/dist/Kz-harness-win32-x64/Kz-harness.exe: the app with its own
// name, icon and version info, the app files in one archive, and Electron's
// "fuses" set so the exe itself cannot be turned into a Node runtime or
// opened to debuggers from the command line.
//   npm run package
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packager } from '@electron/packager'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const [out] = await packager({
  dir: '.',
  out: 'dist',
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  name: 'Kz-harness',
  executableName: 'Kz-harness',
  appVersion: pkg.version,
  icon: 'assets/logo.ico',
  asar: true,
  prune: true,
  ignore: [/^\/dist(\/|$)/, /^\/package\.mjs$/],
  appCopyright: 'MIT No Attribution',
  win32metadata: {
    CompanyName: 'kz-95',
    ProductName: 'Kz-harness',
    FileDescription: 'Kz-harness',
    InternalName: 'Kz-harness',
    OriginalFilename: 'Kz-harness.exe',
  },
})

await flipFuses(join(out, 'Kz-harness.exe'), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE cannot turn the exe into plain Node
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS is ignored
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect / --inspect-brk are ignored
  [FuseV1Options.OnlyLoadAppFromAsar]: true, // only the packaged app code runs
})
console.log(`built ${join(out, 'Kz-harness.exe')}`)
