//! Message encryption, byte-for-byte compatible with `public/crypto.js`
//! (PROTOCOL.md §2-3): ECDH P-256 device keys, HKDF-SHA256 wrap keys,
//! RFC 3394 AES-KW wrapped content keys and AES-256-GCM envelopes.

use std::collections::{BTreeMap, HashMap};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use aes_kw::KekAes256;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

pub const WRAP_SALT: &[u8] = b"tailchat/v1/wrap";

// ---------- encoding & randomness ----------

/// base64url without padding.
pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url; trailing `=` padding is tolerated.
pub fn unb64u(text: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).map_err(|_| Error::msg("invalid base64url"))
}

/// Decode base64url into exactly `N` bytes.
pub fn unb64u_n<const N: usize>(text: &str, what: &str) -> Result<[u8; N]> {
    let raw = unb64u(text).map_err(|e| e.context(what))?;
    raw.as_slice().try_into().map_err(|_| Error::msg(format!("{what}: expected {N} bytes, got {}", raw.len())))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the operating system has no random number generator");
    out
}

/// A fresh message id: 16 random bytes, base64url (22 characters).
pub fn new_message_id() -> String {
    b64u(&random_bytes::<16>())
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

// ---------- device keys ----------

/// A public key as the server stores it: `{"kty":"EC","crv":"P-256","x","y"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

impl PublicJwk {
    pub fn from_key(key: &PublicKey) -> Self {
        let point = key.to_encoded_point(false);
        // An uncompressed point always carries both 32-byte big-endian coordinates.
        PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: b64u(point.x().expect("uncompressed point")),
            y: b64u(point.y().expect("uncompressed point")),
        }
    }

    /// Parse and validate (the point must be on the curve).
    pub fn to_key(&self) -> Result<PublicKey> {
        if self.kty != "EC" || self.crv != "P-256" {
            return Err(Error::msg("public key is not an EC P-256 JWK"));
        }
        let x = unb64u_n::<32>(&self.x, "public key x")?;
        let y = unb64u_n::<32>(&self.y, "public key y")?;
        let mut sec1 = [0u8; 65];
        sec1[0] = 0x04; // uncompressed
        sec1[1..33].copy_from_slice(&x);
        sec1[33..].copy_from_slice(&y);
        // Rejects points that are not on the curve (and the identity).
        PublicKey::from_sec1_bytes(&sec1).map_err(|_| Error::msg("public key is not a valid P-256 point"))
    }

    /// The 64 raw bytes x || y.
    pub fn raw(&self) -> Result<[u8; 64]> {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&unb64u_n::<32>(&self.x, "public key x")?);
        out[32..].copy_from_slice(&unb64u_n::<32>(&self.y, "public key y")?);
        Ok(out)
    }
}

/// A private key as JWK (`d` added), for the local state file only.
#[derive(Clone, Serialize, Deserialize)]
pub struct PrivateJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
    pub d: String,
}

impl std::fmt::Debug for PrivateJwk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateJwk").field("x", &self.x).field("y", &self.y).finish_non_exhaustive()
    }
}

pub struct DeviceKey {
    secret: SecretKey,
}

impl DeviceKey {
    pub fn generate() -> Self {
        loop {
            // A random 32-byte string is a valid scalar with overwhelming probability.
            let bytes = Zeroizing::new(random_bytes::<32>());
            if let Ok(secret) = SecretKey::from_slice(bytes.as_ref()) {
                return DeviceKey { secret };
            }
        }
    }

    pub fn from_jwk(jwk: &PrivateJwk) -> Result<Self> {
        let d = Zeroizing::new(unb64u_n::<32>(&jwk.d, "private key d")?);
        let secret = SecretKey::from_slice(d.as_ref()).map_err(|_| Error::msg("private key is not a valid P-256 scalar"))?;
        let key = DeviceKey { secret };
        let public = key.public_jwk();
        if public.x != jwk.x || public.y != jwk.y {
            return Err(Error::msg("private key does not match its public key"));
        }
        Ok(key)
    }

    pub fn to_jwk(&self) -> PrivateJwk {
        let public = self.public_jwk();
        PrivateJwk { kty: public.kty, crv: public.crv, x: public.x, y: public.y, d: b64u(&self.secret.to_bytes()) }
    }

    pub fn public_key(&self) -> PublicKey {
        self.secret.public_key()
    }

    pub fn public_jwk(&self) -> PublicJwk {
        PublicJwk::from_key(&self.public_key())
    }

    /// `Z = ECDH(self, peer)`: the 32-byte shared x coordinate.
    pub fn ecdh(&self, peer: &PublicKey) -> Zeroizing<[u8; 32]> {
        let shared = p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(shared.raw_secret_bytes());
        out
    }
}

/// `HKDF-SHA256(ikm = Z, salt = "tailchat/v1/wrap", info = S.id + "|" + R.id)`.
pub fn derive_wrap_key(shared: &[u8; 32], sender_id: &str, recipient_id: &str) -> Zeroizing<[u8; 32]> {
    let info = format!("{sender_id}|{recipient_id}");
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(WRAP_SALT), shared)
        .expand(info.as_bytes(), out.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// RFC 3394 AES-256 key wrap of a 32-byte key (40 bytes out).
pub fn aes_kw_wrap(kek: &[u8; 32], key: &[u8; 32]) -> [u8; 40] {
    let mut out = [0u8; 40];
    KekAes256::from(*kek).wrap(key, &mut out).expect("40-byte output for a 32-byte key");
    out
}

/// RFC 3394 unwrap; fails if the integrity check does not hold.
pub fn aes_kw_unwrap(kek: &[u8; 32], wrapped: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    if wrapped.len() != 40 {
        return Err(Error::msg(format!("wrapped key must be 40 bytes, got {}", wrapped.len())));
    }
    let mut out = Zeroizing::new([0u8; 32]);
    KekAes256::from(*kek)
        .unwrap(wrapped, out.as_mut())
        .map_err(|_| Error::msg("could not unwrap the message key (wrong device key or tampered envelope)"))?;
    Ok(out)
}

pub fn chat_aad(chat_id: &str, message_id: &str) -> String {
    format!("tailchat/v1|chat:{chat_id}|msg:{message_id}")
}

pub fn status_aad(user_id: &str) -> String {
    format!("tailchat/v1|status:{user_id}")
}

// ---------- envelopes ----------

/// The `payload` of a message (PROTOCOL.md §3). Field order matches the
/// reference client's `JSON.stringify`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub v: Value,
    pub from: String,
    pub iv: String,
    pub ct: String,
    pub keys: BTreeMap<String, String>,
}

impl Envelope {
    pub fn parse(payload: &str) -> Result<Self> {
        let env: Envelope = serde_json::from_str(payload).map_err(|e| Error::msg(format!("malformed envelope: {e}")))?;
        if env.v != 1 {
            return Err(Error::msg("unsupported envelope version"));
        }
        Ok(env)
    }
}

/// Why an envelope could not be opened.
#[derive(Debug)]
pub enum OpenError {
    /// The message was not encrypted for this device (it was linked later).
    NoKey,
    /// The sender's public key is not in the ring.
    UnknownSender(String),
    Failed(Error),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::NoKey => f.write_str("not encrypted for this device"),
            OpenError::UnknownSender(id) => write!(f, "unknown sender device {id}"),
            OpenError::Failed(e) => write!(f, "{e}"),
        }
    }
}

/// This device's private key plus a cache of peers' public keys and the
/// wrap keys derived from them (each costs an ECDH).
pub struct KeyRing {
    pub device_id: String,
    key: DeviceKey,
    public_keys: HashMap<String, PublicKey>,
    wrap_keys: HashMap<String, Zeroizing<[u8; 32]>>,
}

impl KeyRing {
    pub fn new(device_id: String, key: DeviceKey) -> Self {
        let mut public_keys = HashMap::new();
        public_keys.insert(device_id.clone(), key.public_key());
        KeyRing { device_id, key, public_keys, wrap_keys: HashMap::new() }
    }

    pub fn device_key(&self) -> &DeviceKey {
        &self.key
    }

    pub fn has_public_key(&self, device_id: &str) -> bool {
        self.public_keys.contains_key(device_id)
    }

    pub fn add_public_key(&mut self, device_id: &str, jwk: &PublicJwk) -> Result<()> {
        if !self.public_keys.contains_key(device_id) {
            let key = jwk.to_key().map_err(|e| e.context(format!("device {device_id}")))?;
            self.public_keys.insert(device_id.to_string(), key);
        }
        Ok(())
    }

    /// The wrap key for `sender -> recipient`; one of them must be us.
    fn wrap_key(&mut self, sender_id: &str, recipient_id: &str) -> Result<[u8; 32], OpenError> {
        let cache_key = format!("{sender_id}|{recipient_id}");
        if let Some(k) = self.wrap_keys.get(&cache_key) {
            return Ok(**k);
        }
        let peer = if sender_id == self.device_id { recipient_id } else { sender_id };
        let public = self.public_keys.get(peer).ok_or_else(|| OpenError::UnknownSender(peer.to_string()))?;
        let shared = self.key.ecdh(public);
        let key = derive_wrap_key(&shared, sender_id, recipient_id);
        let value = *key;
        self.wrap_keys.insert(cache_key, key);
        Ok(value)
    }

    /// Encrypt `content` for every device in `recipients` (and this one).
    pub fn seal(&mut self, content: &Value, aad: &str, recipients: &[(String, PublicJwk)]) -> Result<String> {
        for (id, jwk) in recipients {
            self.add_public_key(id, jwk)?;
        }
        let content_key = Zeroizing::new(random_bytes::<32>());
        let iv = random_bytes::<12>();
        let plaintext = serde_json::to_vec(content)?;
        let ct = Aes256Gcm::new(content_key.as_ref().into())
            .encrypt(&Nonce::from(iv), Payload { msg: &plaintext, aad: aad.as_bytes() })
            .map_err(|_| Error::msg("encryption failed"))?;
        let mut ids: Vec<String> = recipients.iter().map(|(id, _)| id.clone()).collect();
        ids.push(self.device_id.clone());
        let mut keys = BTreeMap::new();
        let me = self.device_id.clone();
        for id in ids {
            if keys.contains_key(&id) {
                continue;
            }
            let kek = self.wrap_key(&me, &id).map_err(|e| Error::msg(e.to_string()))?;
            keys.insert(id, b64u(&aes_kw_wrap(&kek, &content_key)));
        }
        let env = Envelope { v: Value::from(1), from: me, iv: b64u(&iv), ct: b64u(&ct), keys };
        Ok(serde_json::to_string(&env)?)
    }

    /// Decrypt an envelope. The sender's public key must already be in the
    /// ring (see [`Envelope::from`]).
    pub fn open(&mut self, env: &Envelope, aad: &str) -> Result<Value, OpenError> {
        let wrapped = env.keys.get(&self.device_id).ok_or(OpenError::NoKey)?;
        let wrapped = unb64u(wrapped).map_err(OpenError::Failed)?;
        let kek = self.wrap_key(&env.from, &self.device_id.clone())?;
        let content_key = aes_kw_unwrap(&kek, &wrapped).map_err(OpenError::Failed)?;
        let iv = unb64u_n::<12>(&env.iv, "envelope iv").map_err(OpenError::Failed)?;
        let ct = unb64u(&env.ct).map_err(OpenError::Failed)?;
        let pt = Aes256Gcm::new(content_key.as_ref().into())
            .decrypt(&Nonce::from(iv), Payload { msg: &ct, aad: aad.as_bytes() })
            .map_err(|_| OpenError::Failed(Error::msg("message failed authentication (wrong chat/message id, or tampered)")))?;
        serde_json::from_slice(&pt).map_err(|e| OpenError::Failed(Error::msg(format!("decrypted content is not JSON: {e}"))))
    }
}

/// Security code over a set of device keys (PROTOCOL.md §3): 12 groups of 5 digits.
pub fn security_code(keys: &[PublicJwk]) -> Result<String> {
    let mut digests = Vec::with_capacity(keys.len());
    for k in keys {
        digests.push(b64u(&sha256(&k.raw()?)));
    }
    digests.sort();
    let h = sha256(digests.concat().as_bytes());
    let groups: Vec<String> = (0..12)
        .map(|i| {
            let n = ((u32::from(h[2 * i]) << 16) | (u32::from(h[2 * i + 1]) << 8) | u32::from(h[24 + i % 8])) % 100_000;
            format!("{n:05}")
        })
        .collect();
    Ok(groups.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn base64url_without_padding() {
        assert_eq!(b64u(&[0xfb, 0xff]), "-_8");
        assert_eq!(unb64u("-_8").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(unb64u("-_8=").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(b64u(b""), "");
        assert!(unb64u("not base64!").is_err());
        assert_eq!(new_message_id().len(), 22);
    }

    // RFC 3394 §4.3: wrap 128 bits of key data with a 256-bit KEK.
    #[test]
    fn aes_kw_rfc3394_128_bit_data_256_bit_kek() {
        let kek: [u8; 32] = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F").try_into().unwrap();
        let data = hex("00112233445566778899AABBCCDDEEFF");
        let expected = hex("64E8C3F9CE0F5BA2 63E9777905818A2A 93C8191E7D6E8AE7");
        let kw = KekAes256::from(kek);
        let mut out = [0u8; 24];
        kw.wrap(&data, &mut out).unwrap();
        assert_eq!(out.to_vec(), expected);
        let mut back = [0u8; 16];
        kw.unwrap(&out, &mut back).unwrap();
        assert_eq!(back.to_vec(), data);
    }

    // RFC 3394 §4.6: wrap 256 bits of key data with a 256-bit KEK (our case).
    #[test]
    fn aes_kw_rfc3394_256_bit_data_256_bit_kek() {
        let kek: [u8; 32] = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F").try_into().unwrap();
        let data: [u8; 32] = hex("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F").try_into().unwrap();
        let expected = hex("28C9F404C4B810F4 CBCCB35CFB87F826 3F5786E2D80ED326 CBC7F0E71A99F43B FB988B9B7A02DD21");
        let wrapped = aes_kw_wrap(&kek, &data);
        assert_eq!(wrapped.to_vec(), expected);
        assert_eq!(*aes_kw_unwrap(&kek, &wrapped).unwrap(), data);

        let mut tampered = wrapped;
        tampered[5] ^= 1;
        assert!(aes_kw_unwrap(&kek, &tampered).is_err());
        let mut wrong_kek = kek;
        wrong_kek[0] ^= 1;
        assert!(aes_kw_unwrap(&wrong_kek, &wrapped).is_err());
        assert!(aes_kw_unwrap(&kek, &wrapped[..32]).is_err());
    }

    #[test]
    fn hkdf_uses_salt_and_directional_info() {
        // RFC 5869 is covered by the hkdf crate; here: info is "S|R", order matters.
        let z = [7u8; 32];
        let ab = derive_wrap_key(&z, "A", "B");
        let ba = derive_wrap_key(&z, "B", "A");
        assert_ne!(*ab, *ba);
        let mut manual = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"tailchat/v1/wrap"), &z).expand(b"A|B", &mut manual).unwrap();
        assert_eq!(*ab, manual);
    }

    #[test]
    fn jwk_roundtrip_keeps_32_byte_coordinates() {
        for _ in 0..20 {
            let key = DeviceKey::generate();
            let jwk = key.public_jwk();
            assert_eq!(unb64u(&jwk.x).unwrap().len(), 32);
            assert_eq!(unb64u(&jwk.y).unwrap().len(), 32);
            assert_eq!(jwk.to_key().unwrap(), key.public_key());
            let private = key.to_jwk();
            let again = DeviceKey::from_jwk(&private).unwrap();
            assert_eq!(again.public_jwk(), jwk);
        }
        let mut bad = DeviceKey::generate().public_jwk();
        bad.x = b64u(&[1u8; 31]);
        assert!(bad.to_key().is_err());
        let mut off_curve = DeviceKey::generate().public_jwk();
        off_curve.y = b64u(&[1u8; 32]);
        assert!(off_curve.to_key().is_err());
    }

    #[test]
    fn ecdh_is_symmetric() {
        let a = DeviceKey::generate();
        let b = DeviceKey::generate();
        assert_eq!(*a.ecdh(&b.public_key()), *b.ecdh(&a.public_key()));
    }

    #[test]
    fn seal_and_open_between_devices() {
        let (alice_key, bob_key, eve_key) = (DeviceKey::generate(), DeviceKey::generate(), DeviceKey::generate());
        let alice_pub = alice_key.public_jwk();
        let bob_pub = bob_key.public_jwk();
        let mut alice = KeyRing::new("devA".into(), alice_key);
        let mut bob = KeyRing::new("devB".into(), bob_key);
        let mut eve = KeyRing::new("devE".into(), eve_key);

        let content = serde_json::json!({"type": "text", "text": "héllo 👋"});
        let aad = chat_aad("chat1", "msg1");
        let payload = alice.seal(&content, &aad, &[("devB".into(), bob_pub)]).unwrap();
        let env = Envelope::parse(&payload).unwrap();
        assert_eq!(env.from, "devA");
        assert_eq!(env.keys.len(), 2, "the sender wraps for itself too");
        assert_eq!(unb64u(&env.keys["devB"]).unwrap().len(), 40);
        assert!(payload.starts_with(r#"{"v":1,"from":"devA","iv":"#));

        // The sender can read its own message.
        assert_eq!(alice.open(&env, &aad).unwrap(), content);

        assert!(matches!(bob.open(&env, &aad), Err(OpenError::UnknownSender(_))));
        bob.add_public_key("devA", &alice_pub).unwrap();
        assert_eq!(bob.open(&env, &aad).unwrap(), content);
        // Moving it to another message breaks authentication.
        assert!(matches!(bob.open(&env, &chat_aad("chat1", "msg2")), Err(OpenError::Failed(_))));
        // Not a recipient.
        eve.add_public_key("devA", &alice_pub).unwrap();
        assert!(matches!(eve.open(&env, &aad), Err(OpenError::NoKey)));
        // Claiming to be another sender breaks the unwrap.
        let mut forged = env.clone();
        forged.keys.insert("devE".into(), forged.keys["devB"].clone());
        assert!(matches!(eve.open(&forged, &aad), Err(OpenError::Failed(_))));

        assert!(Envelope::parse(&payload.replace(r#""v":1"#, r#""v":2"#)).is_err());
    }

    #[test]
    fn security_code_format_and_order() {
        let keys: Vec<PublicJwk> = (0..3).map(|_| DeviceKey::generate().public_jwk()).collect();
        let code = security_code(&keys).unwrap();
        let groups: Vec<&str> = code.split(' ').collect();
        assert_eq!(groups.len(), 12);
        assert!(groups.iter().all(|g| g.len() == 5 && g.chars().all(|c| c.is_ascii_digit())));
        let reversed: Vec<PublicJwk> = keys.iter().rev().cloned().collect();
        assert_eq!(security_code(&reversed).unwrap(), code);
    }
}
