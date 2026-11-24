package com.neo.client
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
@RunWith(AndroidJUnit4::class)
class NeoDeviceIdentityInstrumentedTest {
    @Test fun keystoreKeyPersistsAndSignsAcrossInstances() {
        val alias = "neo-instrumented-" + UUID.randomUUID()
        val first = NeoDeviceIdentity(alias)
        first.ensureKey()
        val jwk = first.publicJwk()
        val signature = first.sign("GET", "neo.test", "/v1/memory", 1L, "nonce", "0".repeat(64))
        val second = NeoDeviceIdentity(alias)
        assertEquals(jwk, second.publicJwk())
        assertEquals(86, signature.length)
        assertEquals(43, jwk.getValue("x").length)
        assertEquals(43, jwk.getValue("y").length)
        val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        store.deleteEntry(alias)
    }
    @Test fun sqliteOutboxSurvivesStoreReconstructionOnDevice() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scope = "physical-" + UUID.randomUUID()
        val idempotency = UUID.randomUUID().toString().replace("-", "")
        val body = """{"memory_id":"m-device","payload_ciphertext":"ciphertext-only","payload_nonce":"nonce","key_version":1}"""
        val first = NeoOfflineStore(context, scope)
        val id = first.enqueue("memory.create", "/memory", idempotency, body)
        first.close()

        // A fresh SQLiteOpenHelper instance must recover the same durable row.
        val recovered = NeoOfflineStore(context, scope)
        val pending = recovered.pending()
        assertEquals(1, pending.size)
        assertEquals(id, pending.single().id)
        assertEquals(idempotency, pending.single().idempotencyKey)
        assertEquals(body, pending.single().body)
        assertTrue(pending.single().body.contains("ciphertext-only"))
        assertFalse(pending.single().body.contains("plaintext"))
        recovered.remove(id)
        assertTrue(recovered.pending().isEmpty())
        recovered.close()
        context.deleteDatabase("neo-offline-" + neoAccountScopeHash(scope) + ".db")
    }
}
