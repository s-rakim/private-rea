"""End-to-end encryption, byte-compatible with public/crypto.js (PROTOCOL.md §2-5)."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import BinaryIO, Callable, Iterable, Iterator

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.keywrap import aes_key_unwrap, aes_key_wrap

CHUNK = 1024 * 1024
TAG = 16
WRAP_SALT = b"tailchat/v1/wrap"


class CryptoError(Exception):
    pass


class NoKeyError(CryptoError):
    """The envelope has no wrapped key for this device (linked after it was sent)."""


# ---------- encoding ----------

def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_message_id() -> str:
    return b64u(os.urandom(16))


def chat_aad(chat_id: str, message_id: str) -> str:
    return f"tailchat/v1|chat:{chat_id}|msg:{message_id}"


def status_aad(user_id: str) -> str:
    return f"tailchat/v1|status:{user_id}"


def _dumps(value) -> bytes:
    # Same shape as JSON.stringify: no spaces, raw UTF-8.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# ---------- device keys ----------

def generate_private_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def private_key_to_pem(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")


def private_key_from_pem(pem: str) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise CryptoError("state file does not hold a P-256 key")
    return key


def public_jwk(key: ec.EllipticCurvePublicKey | ec.EllipticCurvePrivateKey) -> dict:
    if isinstance(key, ec.EllipticCurvePrivateKey):
        key = key.public_key()
    nums = key.public_numbers()
    return {"kty": "EC", "crv": "P-256", "x": b64u(nums.x.to_bytes(32, "big")), "y": b64u(nums.y.to_bytes(32, "big"))}


def import_public_jwk(jwk: dict) -> ec.EllipticCurvePublicKey:
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise CryptoError("not a P-256 public key")
    x, y = unb64u(jwk["x"]), unb64u(jwk["y"])
    if len(x) != 32 or len(y) != 32:
        raise CryptoError("bad P-256 coordinates")
    # from_encoded_point validates that the point is on the curve.
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b"\x04" + x + y)


def derive_wrap_key(private_key: ec.EllipticCurvePrivateKey, peer_public: ec.EllipticCurvePublicKey,
                    sender_id: str, recipient_id: str) -> bytes:
    shared = private_key.exchange(ec.ECDH(), peer_public)  # 32-byte x coordinate
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=WRAP_SALT,
        info=f"{sender_id}|{recipient_id}".encode("utf-8"),
    ).derive(shared)


class KeyRing:
    """Mirror of crypto.js KeyRing: seals and opens message envelopes.

    fetch_public_keys(ids) -> [{"id", "publicKey"}, ...] is used for unknown senders.
    """

    def __init__(self, device_id: str, private_key: ec.EllipticCurvePrivateKey,
                 fetch_public_keys: Callable[[list[str]], list[dict]] | None = None):
        self.device_id = device_id
        self.private_key = private_key
        self.fetch_public_keys = fetch_public_keys
        self.public_keys: dict[str, ec.EllipticCurvePublicKey] = {device_id: private_key.public_key()}
        self.wrap_keys: dict[str, bytes] = {}

    def add_public_key(self, device_id: str, jwk: dict) -> None:
        if device_id not in self.public_keys:
            self.public_keys[device_id] = import_public_jwk(jwk)

    def public_key(self, device_id: str) -> ec.EllipticCurvePublicKey:
        if device_id not in self.public_keys and self.fetch_public_keys:
            for d in self.fetch_public_keys([device_id]):
                self.add_public_key(d["id"], d["publicKey"])
        try:
            return self.public_keys[device_id]
        except KeyError:
            raise CryptoError(f"Unknown device {device_id}") from None

    def wrap_key(self, sender_id: str, recipient_id: str) -> bytes:
        cache = f"{sender_id}|{recipient_id}"
        key = self.wrap_keys.get(cache)
        if key is None:
            peer = recipient_id if sender_id == self.device_id else sender_id
            key = derive_wrap_key(self.private_key, self.public_key(peer), sender_id, recipient_id)
            self.wrap_keys[cache] = key
        return key

    def seal(self, content: dict, aad: str, recipients: Iterable[dict]) -> str:
        ids: list[str] = []
        for d in recipients:
            self.add_public_key(d["id"], d["publicKey"])
            if d["id"] not in ids:
                ids.append(d["id"])
        if self.device_id not in ids:
            ids.append(self.device_id)
        content_key = os.urandom(32)
        iv = os.urandom(12)
        ct = AESGCM(content_key).encrypt(iv, _dumps(content), aad.encode("utf-8"))
        keys = {i: b64u(aes_key_wrap(self.wrap_key(self.device_id, i), content_key)) for i in ids}
        return json.dumps({"v": 1, "from": self.device_id, "iv": b64u(iv), "ct": b64u(ct), "keys": keys},
                          separators=(",", ":"))

    def open(self, payload: str | dict, aad: str) -> dict:
        env = json.loads(payload) if isinstance(payload, str) else payload
        if not isinstance(env, dict) or env.get("v") != 1:
            raise CryptoError("Unsupported envelope version")
        wrapped = (env.get("keys") or {}).get(self.device_id)
        if not wrapped:
            raise NoKeyError("Not encrypted for this device")
        try:
            content_key = aes_key_unwrap(self.wrap_key(env["from"], self.device_id), unb64u(wrapped))
            pt = AESGCM(content_key).decrypt(unb64u(env["iv"]), unb64u(env["ct"]), aad.encode("utf-8"))
        except CryptoError:
            raise
        except Exception as err:  # InvalidTag, InvalidUnwrap, bad base64
            raise CryptoError(f"Decryption failed ({type(err).__name__})") from None
        return json.loads(pt.decode("utf-8"))


# ---------- files (§5) ----------

def chunk_iv(prefix: bytes, i: int) -> bytes:
    return prefix + i.to_bytes(4, "big")


def chunk_aad(i: int, last: bool) -> bytes:
    return f"tailchat/v1|file|{i}|{1 if last else 0}".encode("ascii")


def chunk_count(size: int) -> int:
    return max(1, -(-size // CHUNK))


def encrypted_size(size: int) -> int:
    return size + chunk_count(size) * TAG


class FileEncryptor:
    """Streams a plaintext file into the chunked ciphertext blob.

    Iterate it to get the encrypted chunks; afterwards `.file` holds the
    content fields {key, prefix, size, sha256}.
    """

    def __init__(self, stream: BinaryIO, size: int, key: bytes | None = None, prefix: bytes | None = None):
        self.stream = stream
        self.size = size
        self.key = key or os.urandom(32)
        self.prefix = prefix or os.urandom(8)
        self.count = chunk_count(size)
        self.encrypted_size = encrypted_size(size)
        self._digests: list[bytes] = []
        self.done = False

    def __iter__(self) -> Iterator[bytes]:
        aes = AESGCM(self.key)
        for i in range(self.count):
            want = min(CHUNK, self.size - i * CHUNK)
            plain = _read_exact(self.stream, want)
            self._digests.append(hashlib.sha256(plain).digest())
            yield aes.encrypt(chunk_iv(self.prefix, i), plain, chunk_aad(i, i == self.count - 1))
        self.done = True

    @property
    def file(self) -> dict:
        if not self.done:
            raise CryptoError("file not fully encrypted yet")
        return {
            "key": b64u(self.key),
            "prefix": b64u(self.prefix),
            "size": self.size,
            "sha256": b64u(hashlib.sha256(b"".join(self._digests)).digest()),
        }


def _read_exact(stream: BinaryIO, n: int) -> bytes:
    parts, left = [], n
    while left > 0:
        b = stream.read(left)
        if not b:
            raise CryptoError("file changed while it was being encrypted")
        parts.append(b)
        left -= len(b)
    return b"".join(parts)


def encrypt_bytes(data: bytes) -> tuple[bytes, dict]:
    import io
    enc = FileEncryptor(io.BytesIO(data), len(data))
    blob = b"".join(enc)
    return blob, enc.file


def decrypt_stream(read: Callable[[int], bytes], file: dict, write: Callable[[bytes], object]) -> None:
    """Decrypts a chunked blob read from `read(n)`, writing plaintext to `write`.

    Raises CryptoError on a wrong size, tampering, truncation or checksum mismatch.
    The caller must discard what was written if this raises.
    """
    size = int(file["size"])
    key = unb64u(file["key"])
    prefix = unb64u(file["prefix"])
    if len(key) != 32 or len(prefix) != 8:
        raise CryptoError("bad file key or prefix")
    aes = AESGCM(key)
    count = chunk_count(size)
    digests = []
    for i in range(count):
        want = min(CHUNK, size - i * CHUNK) + TAG
        ct = b""
        while len(ct) < want:
            b = read(want - len(ct))
            if not b:
                raise CryptoError("Encrypted file has the wrong size")
            ct += b
        try:
            pt = aes.decrypt(chunk_iv(prefix, i), ct, chunk_aad(i, i == count - 1))
        except Exception:
            raise CryptoError(f"File chunk {i} failed to decrypt") from None
        digests.append(hashlib.sha256(pt).digest())
        write(pt)
    if read(1):
        raise CryptoError("Encrypted file has the wrong size")
    if file.get("sha256") and b64u(hashlib.sha256(b"".join(digests)).digest()) != file["sha256"]:
        raise CryptoError("File checksum mismatch")


def decrypt_bytes(blob: bytes, file: dict) -> bytes:
    import io
    if len(blob) != encrypted_size(int(file["size"])):
        raise CryptoError("Encrypted file has the wrong size")
    out = io.BytesIO()
    decrypt_stream(io.BytesIO(blob).read, file, out.write)
    return out.getvalue()


# ---------- security code (§3) ----------

def security_code(devices: Iterable[dict]) -> str:
    digests = sorted(
        b64u(hashlib.sha256(unb64u(d["publicKey"]["x"]) + unb64u(d["publicKey"]["y"])).digest()) for d in devices
    )
    h = hashlib.sha256("".join(digests).encode("utf-8")).digest()
    groups = []
    for i in range(12):
        n = ((h[2 * i] << 16) | (h[2 * i + 1] << 8) | h[24 + i % 8]) % 100000
        groups.append(f"{n:05d}")
    return " ".join(groups)
