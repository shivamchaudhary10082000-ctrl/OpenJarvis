package com.neo.client

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.interfaces.ECPublicKey

/**
 * Android Keystore identity/signature primitive for NEO.
 * Keep the private key non-exportable. Supply the Access JWT and HTTPS transport
 * from the host app; do not persist bearer tokens in this class.
 */
class NeoDeviceIdentity(private val alias: String = "neo-device-p256") {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun ensureKey() {
        if (store.containsAlias(alias)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        generator.generateKeyPair()
    }

    fun publicJwk(): Map<String, String> {
        ensureKey()
        val publicKey = store.getCertificate(alias).publicKey as ECPublicKey
        return mapOf(
            "kty" to "EC", "crv" to "P-256",
            "x" to base64Url(unsigned32(publicKey.w.affineX.toByteArray())),
            "y" to base64Url(unsigned32(publicKey.w.affineY.toByteArray()))
        )
    }

    fun sign(method: String, host: String, pathAndQuery: String, timestamp: Long, nonce: String, bodySha256Hex: String): String {
        ensureKey()
        val canonical = listOf(method.uppercase(), host, pathAndQuery, timestamp.toString(), nonce, bodySha256Hex).joinToString("\n")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(store.getKey(alias, null) as java.security.PrivateKey)
        signer.update(canonical.toByteArray(Charsets.UTF_8))
        return base64Url(derToRawP256(signer.sign()))
    }

    private fun unsigned32(input: ByteArray): ByteArray {
        val value = if (input.size > 32) input.copyOfRange(input.size - 32, input.size) else input
        return ByteArray(32 - value.size) + value
    }
    private fun base64Url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    // Android's Signature emits ASN.1 DER; WebCrypto ECDSA verify expects r||s (32+32 bytes).
    private fun derToRawP256(der: ByteArray): ByteArray {
        var i = 3
        if (der[1].toInt() and 0x80 != 0) i = 4
        if (der[i].toInt() != 0x02) throw IllegalArgumentException("Invalid ECDSA signature")
        val rLen = der[i + 1].toInt() and 0xff
        val r = der.copyOfRange(i + 2, i + 2 + rLen)
        i += 2 + rLen
        if (der[i].toInt() != 0x02) throw IllegalArgumentException("Invalid ECDSA signature")
        val sLen = der[i + 1].toInt() and 0xff
        val s = der.copyOfRange(i + 2, i + 2 + sLen)
        return unsigned32(r) + unsigned32(s)
    }
}
