package np.nepaltelecom.telemetry.demo

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * This phone's device identity (2026-10-05). An EC P-256 key pair lives in the
 * Android Keystore, and its private half never leaves the Keystore. The server
 * stores only the public key. Each signed request carries a signature over
 * METHOD|PATH|TS|NONCE|sha256(body), which core/device_auth.py checks.
 */
object DeviceKeys {
    private const val ALIAS = "dtwatch_device_key"

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** Creates the key the first time. Later calls do nothing. */
    fun ensureKey() {
        if (keyStore().containsAlias(ALIAS)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        generator.generateKeyPair()
    }

    /** X.509 SubjectPublicKeyInfo DER, the same bytes the server hashes to get the device id. */
    private fun publicDer(): ByteArray {
        ensureKey()
        return keyStore().getCertificate(ALIAS).publicKey.encoded
    }

    /** The public key as PEM, the form the server stores. */
    fun publicKeyPem(): String {
        val b64 = Base64.encodeToString(publicDer(), Base64.NO_WRAP)
        return "-----BEGIN PUBLIC KEY-----\n" +
            b64.chunked(64).joinToString("\n") +
            "\n-----END PUBLIC KEY-----\n"
    }

    /** Same derivation as the server's fingerprint_from_pem: first 32 hex chars of SHA-256 over the DER. */
    fun deviceId(): String = sha256Hex(publicDer()).take(32)

    /** DER-encoded ECDSA signature over [message], base64. The server verifies it with SHA-256. */
    fun sign(message: ByteArray): String {
        ensureKey()
        val key = keyStore().getKey(ALIAS, null) as PrivateKey
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(key)
            update(message)
        }.sign()
        return Base64.encodeToString(signature, Base64.NO_WRAP)
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
