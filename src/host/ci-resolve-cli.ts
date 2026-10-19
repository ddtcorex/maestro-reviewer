/** Entry of the reviewer pipeline's resolve job (docker/resolve.sh); see ci-resolve-run.ts. */
import { writeFile } from 'node:fs/promises'
import { runResolve } from './ci-resolve-run.js'

const { exitCode } = await runResolve(process.env, {
  fetcher: fetch,
  writeFile: (path, text) => writeFile(path, text, 'utf-8'),
  log: (line) => console.log(line),
})
process.exit(exitCode)
