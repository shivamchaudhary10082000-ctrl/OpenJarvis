package com.neo.client
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NeoOfflineStoreTest {
    private fun key() = UUID.randomUUID().toString().replace("-", "")
    @Test fun ciphertextOutboxSurvivesStoreReconstruction() {
        val context = RuntimeEnvironment.getApplication()
        val scope = "account-" + UUID.randomUUID()
        val idempotency = key()
        val body = """{"memory_id":"m1","payload_ciphertext":"ciphertext","payload_nonce":"nonce","key_version":1}"""
        val first = NeoOfflineStore(context, scope)
        val id = first.enqueue("memory.create", "/memory", idempotency, body)
        first.close()
        val recovered = NeoOfflineStore(context, scope)
        val pending = recovered.pending()
        assertEquals(1, pending.size)
        assertEquals(id, pending.single().id)
        assertEquals(idempotency, pending.single().idempotencyKey)
        assertEquals(body, pending.single().body)
        assertFalse(pending.single().body.contains("plaintext"))
        recovered.remove(id)
        assertTrue(recovered.pending().isEmpty())
        recovered.close()
    }
    @Test fun androidApiBaseUrlRequiresHttpsAndAnOriginOnly() {
        validateNeoApiBaseUrl("https://neo.example.com")
        validateNeoApiBaseUrl("https://neo.example.com:8443")

        listOf(
            "http://neo.example.com",
            "https://user:password@neo.example.com",
            "https://neo.example.com/api",
            "https://neo.example.com?token=secret",
            "https://neo.example.com#fragment",
            "not-a-url"
        ).forEach { invalid ->
            try {
                validateNeoApiBaseUrl(invalid)
                fail("Expected invalid API base URL to be rejected: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected: no bearer token may be sent to an insecure/ambiguous origin.
            }
        }
    }

    @Test fun signedHostIncludesOnlyNonDefaultHttpsPorts() {
        assertEquals("neo.example.com", canonicalNeoRequestHost(java.net.URL("https://neo.example.com/v1")))
        assertEquals("neo.example.com:8443", canonicalNeoRequestHost(java.net.URL("https://neo.example.com:8443/v1")))
        assertEquals("neo.example.com", canonicalNeoRequestHost(java.net.URL("https://neo.example.com:443/v1")))
    }

    @Test fun accountScopesUseSeparateDatabases() {
        val context = RuntimeEnvironment.getApplication()
        val a = NeoOfflineStore(context, "account-a-" + UUID.randomUUID())
        val b = NeoOfflineStore(context, "account-b-" + UUID.randomUUID())
        a.enqueue("task.enqueue", "/tasks", key(),
            """{"task_kind":"demo","payload_ciphertext":"cipher","payload_nonce":"nonce","key_version":1}""")
        assertEquals(1, a.pending().size)
        assertTrue(b.pending().isEmpty())
        a.close(); b.close()
    }
    @Test fun plaintextAndUnsupportedFieldsAreRejected() {
        val store = NeoOfflineStore(RuntimeEnvironment.getApplication(), "account-" + UUID.randomUUID())
        try {
            store.enqueue("memory.create", "/memory", key(), """{"memory_id":"m1","plaintext":"secret"}""")
            fail("plaintext must be rejected")
        } catch (_: IllegalArgumentException) { }
        try {
            store.enqueue("memory.create", "/memory", "short", """{"payload_ciphertext":"x","payload_nonce":"n"}""")
            fail("invalid idempotency key must be rejected")
        } catch (_: IllegalArgumentException) { }
        store.close()
    }

    @Test fun chatRequestBuilderCreatesBoundedNonStreamingPayload() {
        val messages = org.json.JSONArray()
            .put(org.json.JSONObject().put("role", "user").put("content", "Hello NEO"))
        val payload = org.json.JSONObject(buildNeoChatCompletionBody(messages, " primary ", 256))
        assertEquals("primary", payload.getString("model"))
        assertEquals(256, payload.getInt("max_tokens"))
        assertEquals(true, payload.getBoolean("allow_fallback"))
        assertEquals("Hello NEO", payload.getJSONArray("messages").getJSONObject(0).getString("content"))
    }

    @Test fun chatRequestBuilderRejectsEmptyMessagesAndUnsafeTokenLimits() {
        try {
            buildNeoChatCompletionBody(org.json.JSONArray())
            fail("empty message list must be rejected")
        } catch (_: IllegalArgumentException) { }
        val messages = org.json.JSONArray().put(
            org.json.JSONObject().put("role", "user").put("content", "Hello")
        )
        listOf(0, 1025).forEach { limit ->
            try {
                buildNeoChatCompletionBody(messages, maxTokens = limit)
                fail("unsafe token limit must be rejected: $limit")
            } catch (_: IllegalArgumentException) { }
        }
    }
}
