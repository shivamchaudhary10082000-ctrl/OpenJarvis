package com.neo.client

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

data class NeoOfflineItem(
    val id: String,
    val kind: String,
    val path: String,
    val idempotencyKey: String,
    val body: String,
    val createdAt: Long
)

/**
 * Durable local queue/cache for NEO. The body column is restricted to API
 * payloads whose content fields are already client-encrypted ciphertext.
 * Do not enqueue plaintext conversation or credential material.
 */
class NeoOfflineStore(context: Context) : SQLiteOpenHelper(context, "neo-offline.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE neo_outbox (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                path TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                body_ciphertext_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )""".trimIndent()
        )
        db.execSQL(
            """CREATE TABLE neo_memory_cache (
                memory_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                trust_state TEXT NOT NULL,
                record_ciphertext_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(memory_id, revision)
            )""".trimIndent()
        )
        db.execSQL("CREATE TABLE neo_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT)")
        db.execSQL("CREATE INDEX neo_outbox_order ON neo_outbox(created_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Schema changes must be additive. Never discard queued ciphertext on upgrade.
    }

    fun enqueue(kind: String, path: String, idempotencyKey: String, body: String): String {
        require(kind == "memory.create" || kind == "task.enqueue")
        require(path == "/memory" || path == "/tasks")
        require(idempotencyKey.matches(Regex("[A-Za-z0-9_-]{16,128}")))
        val payload = JSONObject(body)
        val allowed = if (kind == "memory.create") {
            setOf("memory_id", "payload_ciphertext", "payload_nonce", "key_version", "source_kind")
        } else {
            setOf("task_kind", "payload_ciphertext", "payload_nonce", "key_version", "required_capabilities")
        }
        val keys = payload.keys()
        while (keys.hasNext()) require(keys.next() in allowed) { "Offline queue accepts encrypted fields only" }
        require(payload.has("payload_ciphertext") && payload.has("payload_nonce")) {
            "Offline queue accepts encrypted payloads only"
        }
        val id = java.util.UUID.randomUUID().toString()
        val values = ContentValues().apply {
            put("id", id)
            put("kind", kind)
            put("path", path)
            put("idempotency_key", idempotencyKey)
            put("body_ciphertext_json", body)
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insertOrThrow("neo_outbox", null, values)
        return id
    }

    fun pending(): List<NeoOfflineItem> {
        val items = mutableListOf<NeoOfflineItem>()
        readableDatabase.query(
            "neo_outbox",
            arrayOf("id", "kind", "path", "idempotency_key", "body_ciphertext_json", "created_at"),
            null, null, null, null, "created_at ASC"
        ).use { cursor ->
            while (cursor.moveToNext()) {
                items += NeoOfflineItem(
                    id = cursor.getString(0),
                    kind = cursor.getString(1),
                    path = cursor.getString(2),
                    idempotencyKey = cursor.getString(3),
                    body = cursor.getString(4),
                    createdAt = cursor.getLong(5)
                )
            }
        }
        return items
    }

    fun remove(id: String) {
        writableDatabase.delete("neo_outbox", "id = ?", arrayOf(id))
    }

    fun saveCursor(cursor: String?) {
        val values = ContentValues().apply { put("key", "memory_cursor"); put("value", cursor) }
        writableDatabase.insertWithOnConflict("neo_metadata", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun loadCursor(): String? {
        readableDatabase.query(
            "neo_metadata", arrayOf("value"), "key = ?", arrayOf("memory_cursor"),
            null, null, null
        ).use { cursor -> return if (cursor.moveToFirst()) cursor.getString(0) else null }
    }

    fun cacheMemory(records: JSONArray) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (index in 0 until records.length()) {
                val record = records.optJSONObject(index) ?: continue
                val memoryId = record.optString("memory_id")
                val revision = record.optInt("revision", 0)
                val trustState = record.optString("trust_state")
                if (memoryId.isBlank() || revision < 1) continue
                val values = ContentValues().apply {
                    put("memory_id", memoryId)
                    put("revision", revision)
                    put("trust_state", trustState)
                    // Store the encrypted wire record only; no decryption occurs here.
                    put("record_ciphertext_json", record.toString())
                    put("updated_at", record.optLong("updated_at", 0L))
                }
                db.insertWithOnConflict("neo_memory_cache", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun cachedApprovedMemory(): JSONArray {
        val result = JSONArray()
        readableDatabase.query(
            "neo_memory_cache", arrayOf("record_ciphertext_json"),
            "trust_state IN ('approved','deleted')", null, null, null, "updated_at ASC"
        ).use { cursor ->
            while (cursor.moveToNext()) result.put(JSONObject(cursor.getString(0)))
        }
        return result
    }
}
