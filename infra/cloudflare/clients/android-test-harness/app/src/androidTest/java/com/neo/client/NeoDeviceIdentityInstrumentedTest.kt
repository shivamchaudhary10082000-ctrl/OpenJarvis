package com.neo.client
import androidx.test.ext.junit.runners.AndroidJUnit4
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
}
