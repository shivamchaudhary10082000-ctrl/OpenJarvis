package com.neo.client

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.util.UUID

/**
 * Installable, local-only Android diagnostic shell for validating NEO's
 * Android Keystore identity and SQLite ciphertext outbox on physical devices.
 *
 * This is not the production NEO UI and does not contact a Worker or accept
 * credentials. The queued payload is synthetic test ciphertext, not encrypted
 * user data.
 */
class NeoTestActivity : Activity() {
    private val accountScope = "neo-physical-device-test"
    private val identity by lazy { NeoDeviceIdentity("neo-manual-test-p256") }
    private val storeLazy = lazy { NeoOfflineStore(this, accountScope) }
    private val store by storeLazy
    private lateinit var output: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "NEO Device Test"
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val heading = TextView(this).apply {
            text = "NEO Android device checks"
            textSize = 24f
        }
        val note = TextView(this).apply {
            text = "Local diagnostics only. No login, network connection, microphone, or real user data. The outbox test uses synthetic ciphertext."
            textSize = 14f
            setPadding(0, 12, 0, 20)
        }
        output = TextView(this).apply {
            text = "Ready. Run the checks below."
            textSize = 14f
            setTextIsSelectable(true)
            setPadding(0, 16, 0, 16)
        }
        content.addView(heading)
        content.addView(note)
        content.addView(actionButton("1. Create / verify Keystore identity") { checkIdentity() })
        content.addView(actionButton("2. Queue synthetic encrypted test record") { queueTestRecord() })
        content.addView(actionButton("3. Recover pending records from SQLite") { recoverOutbox() })
        content.addView(actionButton("4. Clear test records") { clearOutbox() })
        content.addView(output)
        val scroll = ScrollView(this).apply { addView(content) }
        setContentView(scroll)
    }

    private fun actionButton(label: String, action: () -> Unit) =
        Button(this).apply {
            text = label
            isAllCaps = false
            gravity = Gravity.CENTER
            setOnClickListener {
                try {
                    action()
                } catch (error: Exception) {
                    output.text = "FAILED: ${error.javaClass.simpleName}: ${error.message}"
                }
            }
        }

    private fun checkIdentity() {
        identity.ensureKey()
        val jwk = identity.publicJwk()
        // Fingerprint only the public coordinates; never expose or export the private key.
        val fingerprintInput = "P-256\n${jwk.getValue("x")}\n${jwk.getValue("y")}"
        val fingerprint = java.security.MessageDigest.getInstance("SHA-256")
            .digest(fingerprintInput.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val signature = identity.sign(
            "GET", "neo.local.test", "/v1/memory", 1L,
            UUID.randomUUID().toString().replace("-", ""),
            "0".repeat(64)
        )
        check(signature.length == 86) { "Unexpected P-256 signature encoding" }
        output.text = buildString {
            appendLine("PASS — Android Keystore identity created and signed a test request.")
            appendLine("Curve: ${jwk["crv"]}")
            appendLine("Public key coordinates: valid 32-byte Base64URL values")
            appendLine("Public-key SHA-256 fingerprint: $fingerprint")
            appendLine("Compare this fingerprint before and after an app restart; matching values prove the same public identity was reused.")
            appendLine("Signature length: ${signature.length}")
            appendLine("The private key remains inside Android Keystore.")
            appendLine("Run this check again after closing/reopening the app to check persistence.")
        }
    }

    private fun queueTestRecord() {
        val idempotencyKey = UUID.randomUUID().toString().replace("-", "")
        val body = JSONObject()
            .put("memory_id", "physical-device-test")
            .put("payload_ciphertext", "SYNTHETIC_TEST_CIPHERTEXT_DO_NOT_USE_AS_REAL_DATA")
            .put("payload_nonce", "SYNTHETIC_TEST_NONCE")
            .put("key_version", 1)
            .toString()
        val id = store.enqueue("memory.create", "/memory", idempotencyKey, body)
        output.text = "PASS — synthetic ciphertext record queued locally.\nOutbox ID: $id\nIdempotency key: $idempotencyKey\nNo network request was made."
    }

    private fun recoverOutbox() {
        val items = store.pending()
        output.text = buildString {
            appendLine("SQLite recovery result: ${items.size} pending record(s).")
            items.forEachIndexed { index, item ->
                appendLine()
                appendLine("${index + 1}. ${item.kind}")
                appendLine("ID: ${item.id}")
                appendLine("Idempotency key: ${item.idempotencyKey}")
                appendLine("Ciphertext field present: ${item.body.contains("payload_ciphertext")}")
                appendLine("Synthetic test data only; not synced.")
            }
            if (items.isEmpty()) appendLine("No records found. Queue a test record first.")
        }
    }

    private fun clearOutbox() {
        val items = store.pending()
        items.forEach { store.remove(it.id) }
        output.text = "Cleared ${items.size} local test record(s)."
    }

    override fun onDestroy() {
        if (storeLazy.isInitialized()) {
            try { store.close() } catch (_: Exception) { }
        }
        super.onDestroy()
    }
}
