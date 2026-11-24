package com.neo.client

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/**
 * Reject insecure or ambiguous API origins before any Access token can be sent.
 * NEO Android API traffic must use HTTPS and an origin-only base URL.
 */
internal fun validateNeoApiBaseUrl(baseUrl: String) {
    val uri = try {
        java.net.URI(baseUrl)
    } catch (error: Exception) {
        throw IllegalArgumentException("NEO API base URL must be a valid HTTPS origin", error)
    }
    require(uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()) {
        "NEO API base URL must use HTTPS"
    }
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) {
        "NEO API base URL must contain only an origin, without credentials, path, query or fragment"
    }
}

/**
 * Small Android transport for the NEO Worker. Uses an Android Keystore-backed
 * non-exportable P-256 signing key. The caller supplies a fresh Cloudflare
 * Access JWT for every request and owns microphone/audio permission handling.
 *
 * Requires OkHttp 4.12+ and Android API 23+.
 */
class NeoAndroidClient(
    context: Context,
    private val baseUrl: String,
    private val accessToken: suspend () -> String,
    accountScope: String,
    private val identity: NeoDeviceIdentity = NeoDeviceIdentity("neo-device-p256-${neoAccountScopeHash(accountScope)}"),
    private val http: OkHttpClient = OkHttpClient(),
    private val offlineStore: NeoOfflineStore = NeoOfflineStore(context, accountScope)
) {
    init {
        validateNeoApiBaseUrl(baseUrl)
    }

    private val prefs = context.getSharedPreferences("neo_device_${neoAccountScopeHash(accountScope)}", Context.MODE_PRIVATE)
    val deviceId: String = prefs.getString("device_id", null) ?: UUID.randomUUID().toString().replace("-", "").also {
        prefs.edit().putString("device_id", it).apply()
    }

    fun enrolmentBody(label: String, platform: String = "android", capabilities: List<String> = emptyList()): String {
        identity.ensureKey()
        return JSONObject()
            .put("label", label)
            .put("platform", platform)
            .put("public_key_jwk", JSONObject(identity.publicJwk()))
            .put("capabilities", org.json.JSONArray(capabilities))
            .toString()
    }

    suspend fun enrol(label: String, capabilities: List<String> = emptyList()): okhttp3.Response {
        val token = accessToken()
        val body = enrolmentBody(label, capabilities = capabilities)
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + "/v1/devices")
            .header("Authorization", "Bearer $token")
            .header("X-NEO-Device-ID", deviceId)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        return withContext(Dispatchers.IO) { http.newCall(request).execute() }
    }

    suspend fun signedRequest(
        method: String,
        pathAndQuery: String,
        body: ByteArray = ByteArray(0),
        contentType: String? = null,
        extraHeaders: Map<String, String> = emptyMap()
    ): okhttp3.Response {
        require(pathAndQuery.startsWith("/")) { "Path must be absolute" }
        val url = baseUrl.trimEnd('/') + "/v1" + pathAndQuery
        val parsed = java.net.URL(url)
        // URL.host excludes a non-default port; the Worker signs URL.host,
        // which includes that port, so preserve it in the canonical request.
        val canonicalHost = if (parsed.port != -1 && parsed.port != 443) {
            parsed.host + ":" + parsed.port
        } else {
            parsed.host
        }
        val timestamp = System.currentTimeMillis() / 1000
        val nonceBytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val nonce = Base64.encodeToString(nonceBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val bodyHash = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val path = parsed.file.ifEmpty { "/" }
        val signature = identity.sign(method, canonicalHost, path, timestamp, nonce, bodyHash)
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${accessToken()}")
            .header("X-NEO-Device-ID", deviceId)
            .header("X-NEO-Timestamp", timestamp.toString())
            .header("X-NEO-Nonce", nonce)
            .header("X-NEO-Signature", signature)
        extraHeaders.forEach { (name, value) -> builder.header(name, value) }
        val media = (contentType ?: "application/octet-stream").toMediaType()
        when (method.uppercase()) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete(body.toRequestBody(media))
            "POST" -> builder.post(body.toRequestBody(media))
            "PATCH" -> builder.patch(body.toRequestBody(media))
            else -> error("Unsupported HTTP method")
        }
        return withContext(Dispatchers.IO) { http.newCall(builder.build()).execute() }
    }

    suspend fun syncApprovedMemory(cursor: String? = null): JSONObject {
        val activeCursor = cursor ?: withContext(Dispatchers.IO) { offlineStore.loadCursor() }
        val query = activeCursor?.let { "?cursor=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""
        val response = try {
            signedRequest("GET", "/memory$query")
        } catch (error: IOException) {
            return JSONObject()
                .put("records", withContext(Dispatchers.IO) { offlineStore.cachedApprovedMemory() })
                .put("next_cursor", activeCursor)
                .put("offline", true)
        }
        response.use {
            if (!it.isSuccessful) throw IllegalStateException("Memory sync failed: ${it.code}")
            val payload = JSONObject(it.body?.string() ?: "{}")
            withContext(Dispatchers.IO) {
                offlineStore.cacheMemory(payload.optJSONArray("records") ?: org.json.JSONArray())
                val next = payload.optString("next_cursor", "")
                if (next.isNotEmpty()) offlineStore.saveCursor(next)
            }
            payload.put("offline", false)
            return payload
        }
    }

    private fun sanitizeEncryptedPayload(jsonBody: String, allowedFields: Set<String>): String {
        val payload = JSONObject(jsonBody)
        val keys = payload.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            require(key in allowedFields) { "Offline-capable payload contains an unsupported field: $key" }
        }
        require(payload.has("payload_ciphertext") && payload.has("payload_nonce")) {
            "Offline-capable payload must contain encrypted ciphertext and nonce"
        }
        return payload.toString()
    }

    suspend fun createEncryptedMemory(jsonBody: String, idempotencyKey: String = UUID.randomUUID().toString().replace("-", "")): JSONObject {
        val safeBody = sanitizeEncryptedPayload(
            jsonBody, setOf("memory_id", "payload_ciphertext", "payload_nonce", "key_version", "source_kind")
        )
        val headers = mapOf("Idempotency-Key" to idempotencyKey, "Content-Type" to "application/json")
        val response = try {
            signedRequest("POST", "/memory", safeBody.toByteArray(), "application/json", headers)
        } catch (error: IOException) {
            val id = withContext(Dispatchers.IO) { offlineStore.enqueue("memory.create", "/memory", idempotencyKey, safeBody) }
            return JSONObject().put("status", "queued_offline").put("outbox_id", id).put("idempotency_key", idempotencyKey)
        }
        response.use {
            if (it.isSuccessful) return JSONObject(it.body?.string() ?: "{}")
            if (it.code == 408 || it.code == 425 || it.code == 429 || it.code >= 500) {
                val id = withContext(Dispatchers.IO) { offlineStore.enqueue("memory.create", "/memory", idempotencyKey, safeBody) }
                return JSONObject().put("status", "queued_offline").put("outbox_id", id).put("idempotency_key", idempotencyKey)
            }
            throw IllegalStateException("Memory write failed: ${it.code}")
        }
    }

    suspend fun queueEncryptedTask(jsonBody: String, idempotencyKey: String = UUID.randomUUID().toString().replace("-", "")): JSONObject {
        val safeBody = sanitizeEncryptedPayload(
            jsonBody, setOf("task_kind", "payload_ciphertext", "payload_nonce", "key_version", "required_capabilities")
        )
        val headers = mapOf("Idempotency-Key" to idempotencyKey, "Content-Type" to "application/json")
        val response = try {
            signedRequest("POST", "/tasks", safeBody.toByteArray(), "application/json", headers)
        } catch (error: IOException) {
            val id = withContext(Dispatchers.IO) { offlineStore.enqueue("task.enqueue", "/tasks", idempotencyKey, safeBody) }
            return JSONObject().put("status", "queued_offline").put("outbox_id", id).put("idempotency_key", idempotencyKey)
        }
        response.use {
            if (it.isSuccessful) return JSONObject(it.body?.string() ?: "{}")
            if (it.code == 408 || it.code == 425 || it.code == 429 || it.code >= 500) {
                val id = withContext(Dispatchers.IO) { offlineStore.enqueue("task.enqueue", "/tasks", idempotencyKey, safeBody) }
                return JSONObject().put("status", "queued_offline").put("outbox_id", id).put("idempotency_key", idempotencyKey)
            }
            throw IllegalStateException("Task enqueue failed: ${it.code}")
        }
    }

    suspend fun flushOutbox(): JSONObject {
        var sent = 0
        var blockedOn: String? = null
        val pendingItems = withContext(Dispatchers.IO) { offlineStore.pending() }
        for (item in pendingItems) {
            val response = try {
                signedRequest(
                    "POST", item.path, item.body.toByteArray(), "application/json",
                    mapOf("Idempotency-Key" to item.idempotencyKey, "Content-Type" to "application/json")
                )
            } catch (error: IOException) {
                blockedOn = item.id
                break
            }
            val accepted = response.use {
                if (it.isSuccessful) {
                    withContext(Dispatchers.IO) { offlineStore.remove(item.id) }
                    sent++
                    true
                } else {
                    blockedOn = item.id
                    false
                }
            }
            if (!accepted) break
        }
        return JSONObject()
            .put("sent", sent)
            .put("remaining", withContext(Dispatchers.IO) { offlineStore.pending().size })
            .put("blocked_on", blockedOn)
    }

    suspend fun heartbeat(): okhttp3.Response =
        signedRequest("POST", "/devices/heartbeat", "{}".toByteArray(), "application/json")

    suspend fun claimTask(leaseSeconds: Int = 90): okhttp3.Response =
        signedRequest("POST", "/tasks/claim", JSONObject().put("lease_seconds", leaseSeconds).toString().toByteArray(), "application/json")

    suspend fun transcribe(audio: ByteArray, mimeType: String = "audio/webm"): okhttp3.Response =
        signedRequest("POST", "/voice/transcribe", audio, mimeType)

    suspend fun synthesize(jsonBody: String): okhttp3.Response =
        signedRequest("POST", "/voice/synthesize", jsonBody.toByteArray(), "application/json")
}
