What you just created

Not one key — a keypair, twice:

- A primary key (ed25519) whose job is to sign and certify — it's your identity, "I am Santiago".
- An encryption subkey (cv25519) whose job is to receive encrypted data — this is the one gopass will actually use.

Each of those has two halves: a public key (shareable with the world, used to encrypt things for you and verify your signatures) and a private key (never leaves your machine, the only thing that can decrypt). That fingerprint you saw — E58773...96C1 — is a hash of the public key: a short, unforgeable name for your identity.

And your private key is not sitting naked on disk: GPG encrypted it with your passphrase. That's why you'll be asked for it when decrypting secrets.

What revoking means

That .rev file is a revocation certificate: a pre-signed public statement that says "this key is no longer trustworthy — stop using it." You'd publish it if your key ever gets stolen or you lose the passphrase.

And here's the subtle part — the reason GPG generates it NOW, at creation time: only the private key can sign its own death sentence. If your key is stolen or lost later, you might no longer be able to produce that statement. So GPG hands it to you upfront, while you still control everything. It's the crypto equivalent of writing your will while healthy. Guard that file like the key itself — anyone holding it can kill your key.

The principles at play here

Three layers are stacked in what we're building, and this composition is 90% of real-world cryptography:

1. Symmetric encryption — one shared secret both locks and unlocks (AES). Fast, but it has the eternal problem: how do two parties agree on the secret? Your passphrase protecting the private key on disk is this layer.
2. Asymmetric encryption — the genius move that solved that probllic half encrypts, private half decrypts. It works because ofone-way math — operations easy in one direction, computationally infeasible to reverse. Your key uses elliptic curves (Curve25519): multiplying a point on a curve by a big number is easy; recovering the number from the result is the hard problem.
3. Hybrid encryption — the trick almost nobody tells beginners: anobody encrypts actual data with it. When gopass encrypts your APIkey, GPG generates a random one-time symmetric key, encrypts your data with THAT (fast), then encrypts the little key asymmetrically with your public key. TLS/HTTPS does exactly the same dance. Once you see this pattern, you see it everywhere.

Plus a fourth, quieter one: key derivation — your human passphrase gets stretched through a deliberately slow hash into a proper encryption key, so brute-forcing
it costs attackers real time.

The ladder, in increasing difficulty

If you want to climb this properly, this is the order:

1. Hashing — one-way fingerprints (SHA-256). Integrity, not secrecy. You saw it: your key fingerprint, git commits, password storage.
2. Symmetric encryption — AES, shared secret, and why key distrib
3. KDFs — bcrypt, scrypt, Argon2. Why "hash the password" is not enough.
4. Asymmetric + digital signatures — where you are now. Signing = encrypting a hash with your private key, so anyone can verify with the public one.
5. Key exchange (Diffie-Hellman) — two strangers agree on a secreut ever transmitting it. Genuinely magical the first time you trace it.
6. Hybrid systems in the wild — read a TLS 1.3 handshake end to end. Everything above composes into it.
7. Forward secrecy & the Signal double ratchet — keys that rotate per message, so stealing today's key can't decrypt yesterday.
8. The frontier — zero-knowledge proofs (prove you know somethingorphic encryption (compute on encrypted data), and post-quantumcrypto (curves like yours fall to quantum computers; NIST already standardized replacements like Kyber).

One golden rule to carry with you: you compose these primitives, you never invent them. The moment someone designs their own cipher, that's when systems die.