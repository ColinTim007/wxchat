import { Hono } from 'hono'
import type { Env, JwtPayload } from '../types.js'

const files = new Hono<{
  Bindings: Env
  Variables: { user: JwtPayload }
}>()

// 为个人免费部署设置 20 MiB 的文件限制
const MAX_FILE_SIZE = 20 * 1024 * 1024

// 上传文件
files.post('/upload', async (c) => {
  try {
    const { DB, FILES } = c.env
    const formData = await c.req.formData()
    const file = formData.get('file')
    const deviceId = formData.get('deviceId')

    if (!(file instanceof File) ||
        typeof deviceId !== 'string' || !deviceId) {
      return c.json({
        success: false,
        error: '文件和设备ID不能为空'
      }, 400)
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json({
        success: false,
        error: '文件不能超过20MB'
      }, 413)
    }

    const timestamp = Date.now()
    const randomStr = crypto.randomUUID()
    const extension = file.name.split('.').pop() || 'bin'
    const fileKey = `${timestamp}-${randomStr}.${extension}`

    try {
      const data = await file.arrayBuffer()
      await FILES.put(fileKey, data)
    } catch (storageError) {
      console.error('KV上传失败:', storageError)
      return c.json({
        success: false,
        error: '文件写入KV存储失败'
      }, 500)
    }

    try {
      const results = await DB.batch([
        DB.prepare(
          `INSERT INTO files
           (original_name, file_name, file_size,
            mime_type, r2_key, upload_device_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          file.name,
          fileKey,
          file.size,
          file.type || 'application/octet-stream',
          fileKey,
          deviceId
        ),
        DB.prepare(
          `INSERT INTO messages (type, file_id, device_id)
           SELECT 'file', id, ? FROM files WHERE r2_key = ?`
        ).bind(deviceId, fileKey)
      ])

      const result = results[0]

      return c.json({
        success: true,
        data: {
          fileId: result.meta.last_row_id,
          fileName: file.name,
          fileSize: file.size,
          r2Key: fileKey
        }
      })
    } catch (dbError) {
      await FILES.delete(fileKey).catch(console.error)
      console.error('数据库写入失败:', dbError)
      return c.json({
        success: false,
        error: '数据库写入失败'
      }, 500)
    }
  } catch (error) {
    console.error('文件上传失败:', error)
    return c.json({
      success: false,
      error: '文件上传失败'
    }, 500)
  }
})

// 下载文件
files.get('/download/:r2Key', async (c) => {
  try {
    const { DB, FILES } = c.env
    const fileKey = c.req.param('r2Key')

    const fileInfo = await DB.prepare(
      'SELECT * FROM files WHERE r2_key = ?'
    )
      .bind(fileKey)
      .first<{
        original_name: string
        mime_type: string
        file_size: number
      }>()

    if (!fileInfo) {
      return c.json({
        success: false,
        error: '文件不存在'
      }, 404)
    }

    const data = await FILES.get(fileKey, 'arrayBuffer')

    if (data === null) {
      return c.json({
        success: false,
        error: 'KV中未找到文件'
      }, 404)
    }

    await DB.prepare(
      `UPDATE files
       SET download_count = download_count + 1
       WHERE r2_key = ?`
    )
      .bind(fileKey)
      .run()

    const encodedName = encodeURIComponent(fileInfo.original_name)

    return new Response(data, {
      headers: {
        'Content-Type': fileInfo.mime_type || 'application/octet-stream',
        'Content-Disposition':
          `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch (error) {
    console.error('文件下载失败:', error)
    return c.json({
      success: false,
      error: '文件下载失败'
    }, 500)
  }
})

export default files
