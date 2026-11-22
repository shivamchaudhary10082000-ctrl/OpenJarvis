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
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

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
    private val identity: NeoDeviceIdentity = NeoDeviceIdentity(),
    private val http: OkHttpClient = OkHttpClient()
) {
    private val prefs = context.getSharedPreferences("neo_device", Context.MODE_PRIVATE)
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

    suspend fun signedRequest(method: String, pathAndQuery: String, body: ByteArray = ByteArray(0), contentType: String? = null): okhttp3.Response {
        require(pathAndQuery.startsWith("/")) { "Path must be absolute" }
        val url = baseUrl.trimEnd('/') + "/v1" + pathAndQuery
        val parsed = java.net.URL(url)
        val timestamp = System.currentTimeMillis() / 1000
        val nonceBytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val nonce = Base64.encodeToString(nonceBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val bodyHash = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val path = parsed.file.ifEmpty { "/" }
        val signature = identity.sign(method, parsed.host, path, timestamp, nonce, bodyHash)
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${accessToken()}")
            .header("X-NEO-Device-ID", deviceId)
            .header("X-NEO-Timestamp", timestamp.toString())
            .header("X-NEO-Nonce", nonce)
            .header("X-NEO-Signature", signature)
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

    suspend fun syncApprovedMemory(cursor: String? = null): okhttp3.Response {
        val query = cursor?.let { "?cursor=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""
        return signedRequest("GET", "/memory$query")
    }

    suspend fun transcribeMultipart(fileName: String, mimeType: String, audio: ByteArray): okhttp3.Response {
        val boundary = "neo-" + UUID.randomUUID().toString()
        val prefix = "--$boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n" +
            "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$fileName\"\r\nContent-Type: $mimeType\r\n\r\n"
        val suffix = "\r\n--$boundary--\r\n"
        val body = prefix.toByteArray() + audio + suffix.toByteArray()
        return signedRequest("POST", "/voice/transcribe", body, "multipart/form-data; boundary=$boundary")
    }

    suspend fun synthesize(jsonBody: String): okhttp3.Response =
        signedRequest("POST", "/voice/synthesize", jsonBody.toByteArray(), "application/json")
}
