/** Entry of the reviewer pipeline's scheduled report job (docker/report.sh); see ci-report.ts. */
import { writeFile } from 'node:fs/promises'
import { runReport } from './ci-report.js'

process.exit(await runReport(process.env, {
  fetcher: fetch,
  writeFile: (path, text) => writeFile(path, text, 'utf-8'),
  log: (line) => console.log(line),
}))
