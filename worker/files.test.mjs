import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import files from './routes/files.ts'

function setup(failMessage = false) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8'))
  if (failMessage) sql.exec(`CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
  const values = new Map()
  const DB = {
    prepare(query) {
      let params = []
      return {
        bind(...args) { params = args; return this },
        async run() {
          const result = sql.prepare(query).run(...params)
          return { meta: { last_row_id: Number(result.lastInsertRowid) } }
        },
        async first() { return sql.prepare(query).get(...params) ?? null }
      }
    },
    async batch(statements) {
      sql.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sql.exec('COMMIT')
        return results
      } catch (error) {
        sql.exec('ROLLBACK')
        throw error
      }
    }
  }
  const FILES = {
    async put(key, value) { values.set(key, value) },
    async get(key) { return values.get(key) ?? null },
    async delete(key) { values.delete(key) }
  }
  return { sql, values, env: { DB, FILES } }
}

async function upload(env) {
  const body = new FormData()
  body.append('file', new File(['hello'], '测试.txt', { type: 'text/plain' }))
  body.append('deviceId', 'test-device')
  return files.request('/upload', { method: 'POST', body }, env)
}

const failed = setup(true)
assert.equal((await upload(failed.env)).status, 500)
assert.equal(failed.sql.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0, 'failed upload must roll back its file record')
assert.equal(failed.values.size, 0, 'failed upload must remove its KV object')

const ok = setup()
const response = await upload(ok.env)
assert.equal(response.status, 200)
const { data } = await response.json()
assert.equal(ok.sql.prepare('SELECT file_id FROM messages').get().file_id, data.fileId)
const download = await files.request(`/download/${data.r2Key}`, {}, ok.env)
assert.equal(download.status, 200)
assert.equal(await download.text(), 'hello')
assert.match(download.headers.get('content-disposition'), /%E6%B5%8B%E8%AF%95/)
console.log('PASS: database rollback, KV cleanup, upload and download')
