# Runbook — from `git clone` to a settled x402 payment

Every command here is copy-paste. Blocks marked **once** are one-time setup;
everything after that is what you run each session.

The program is already deployed to devnet at
`HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4`, so if you only want to *watch*
it work you can skip straight to [5. Run the demo](#5-run-the-demo) after
steps 1–3.

---

## 1. Install the toolchain — **once**

macOS or Linux. Each install prints a line telling you to restart your shell
or `source` a file; do what it says before running the next one.

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor, pinned to the version this project builds with
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.29.0
avm use 0.29.0
```

Node.js 18+ is also required (`node --version` to check; install from
nodejs.org or your package manager if missing).

Verify all four:

```bash
rustc --version && solana --version && anchor --version && node --version
```

### macOS only — **once**

macOS writes extended attributes into archives as `._` companion files, which
makes `solana-test-validator` refuse to unpack its own genesis archive
(`Archive error: extra entry found: "._genesis.bin"`). One variable prevents it
permanently:

```bash
echo 'export COPYFILE_DISABLE=1' >> ~/.zshrc
source ~/.zshrc
```

---

## 2. Get the code

```bash
git clone https://github.com/edison9733/agentCTOS.git
cd agentCTOS
git checkout claude/x402-solana-scoring-p3yoot
npm install
```

---

## 3. Create and fund a wallet — **once**

```bash
solana-keygen new                     # skip if you already have ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2
solana balance
```

If the airdrop is rate-limited (common — it usually is), use the
proof-of-work faucet instead. It mines devnet SOL to your configured wallet
and ignores IP rate limits:

```bash
cargo +stable install devnet-pow
devnet-pow mine --url https://api.devnet.solana.com
```

The `+stable` matters: this repo pins Rust 1.75 via `rust-toolchain.toml`, and
`devnet-pow` needs a newer edition, so it has to build with your default
toolchain rather than the project's.

**How much you need:** ~0.1 SOL to run the demo, ~2 SOL to deploy the program
yourself. You do not need to deploy to run the demo.

---

## 4. Build and test

```bash
anchor build
anchor test
```

Expect **9 passing** in about two minutes. One test genuinely sleeps 62
seconds — the program enforces a 60-second minimum escrow timeout, and that
test waits it out to prove the reclaim path really is time-gated. That's not a
hang.

`anchor test` starts its own local validator, so it costs no devnet SOL and
works offline.

---

## 5. Run the demo

```bash
export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
npm run demo
```

Five acts, ~2 minutes. Each states a claim, then proves it with a real devnet
transaction and re-reads the result from the program's own accounts.

**If you hit `429 Too Many Requests`,** the public devnet RPC is throttling
you. Get a free key at [helius.dev](https://helius.dev) and use it instead:

```bash
export ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
npm run demo
```

The quotes matter in zsh — an unquoted `?` is a glob and the shell will refuse
the URL with `no matches found`.

### Presenting it

Act 5 waits out the remaining escrow timeout, which is ~45 seconds of a
progress line and nothing else. Two ways to handle that:

- **Run it once before you present** and leave the finished output on screen.
  Scroll through it and talk to each act. Re-run live only if someone asks.
- **Run it live and talk through the wait.** The pause is the most convincing
  part of the demo if you narrate it: the merchant cannot stop the clock, and
  the buyer needs nobody's permission to reclaim when it runs out.

To capture a clean transcript to show later:

```bash
npm run demo 2>&1 | tee demo-output.txt
```

---

## 6. Make a payment yourself

The demo is scripted. This drives one real payment through the same program,
so you choose the amount and how it settles:

```bash
npm run pay -- --amount 25
```

That registers a fresh merchant, pays it 25 tokens, and confirms delivery —
printing the escrow split, both token balances, and the merchant's counters
before and after.

| Command | What it shows |
|---|---|
| `npm run pay -- --amount 25` | The happy path. New merchant → tier 1 → 100% escrowed → released on confirmation. |
| `npm run pay -- --amount 25 --settle refund` | Buyer changes their mind before delivery; escrow returns and a refund event is recorded. |
| `npm run pay -- --amount 5 --settle reclaim --timeout 60` | The rug. Merchant never delivers; after 60s the buyer takes the money back **with no merchant signature**. |
| `npm run pay -- --amount 25 --settle hold` | Leaves the escrow open so you can inspect the vault on Explorer. |

### Building a merchant's reputation

A merchant's tier is a pure function of its settled orders, so you can watch
it move. The script prints the exact command to reuse the merchant it just
created:

```bash
npm run pay -- --amount 10 --merchant <MERCHANT_OWNER_PUBKEY>
```

Run that five times with the same merchant. On the fifth, `tier` goes
`1 → 2` — and the *sixth* payment will be mostly instant instead of fully
escrowed, because tier 2 only requires a 10% reserve.

Then try one large order against that same merchant:

```bash
npm run pay -- --amount 500 --merchant <MERCHANT_OWNER_PUBKEY>
```

It gets forced back to 100% escrow with `forced_full_escrow: true` — 500 is
more than 10× its ~10-token average, so the size check revokes the tier
discount for that payment only. This is the single most convincing thing you
can show live, because the merchant's tier is still 2; it's the *payment* that
was judged, not the merchant.

---

## 7. Verify it independently

Everything the demo prints is re-read from on-chain accounts, but don't take
its word for it. Both scripts print Explorer links; open a **Merchant PDA**
link and you'll see the raw account data — tier, counters, settlement history
— with no backend of ours in the path.

```bash
solana account <MERCHANT_PDA> --url devnet     # the same bytes, from the CLI
```

---

## 8. Deploy your own copy — optional

Only needed if you change the Rust program. Requires ~2 SOL.

```bash
anchor build

solana program deploy target/deploy/x402_scoring.so \
  --program-id target/deploy/x402_scoring-keypair.json \
  --url https://api.devnet.solana.com \
  --use-rpc --max-sign-attempts 50 \
  --with-compute-unit-price 50000
```

`--with-compute-unit-price` is what actually gets you through devnet
congestion. Without it you will watch `Blockhash expired` count down to zero
and fail; `--max-sign-attempts` alone only retries at the same losing priority.

### If the deploy fails partway

It prints a 12-word seed phrase for the partially-written buffer. Recover it
and resume rather than paying to re-upload those bytes:

```bash
solana-keygen recover -o /tmp/buffer.json --force 'prompt://?key=0/0'
# paste the 12 words, Enter for empty passphrase, y to confirm

solana program deploy target/deploy/x402_scoring.so \
  --program-id target/deploy/x402_scoring-keypair.json \
  --buffer /tmp/buffer.json \
  --url https://api.devnet.solana.com \
  --use-rpc --max-sign-attempts 50 --with-compute-unit-price 50000
```

### If you see `account data too small for instruction`

The ProgramData account is sized at first deploy and does not grow on its own,
so a larger binary fails to upgrade. Extend it, then redeploy:

```bash
solana program extend <PROGRAM_ID> 20000 --url https://api.devnet.solana.com
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Archive error: extra entry found: "._genesis.bin"` | macOS AppleDouble files. `export COPYFILE_DISABLE=1`, then `rm -rf .anchor/test-ledger test-ledger`. |
| `429 Too Many Requests` | Public devnet RPC throttling. Use a Helius key (step 5). |
| `invalid account data for instruction` right after startup | An RPC node that hasn't caught up. Both scripts already confirm at `"confirmed"` to prevent this; if you wrote your own script, don't use Anchor's default `"processed"`. |
| `Blockhash expired` during deploy | Devnet congestion. Add `--with-compute-unit-price 50000`. |
| `account data too small for instruction` | `solana program extend` (step 8). |
| `insufficient lamports` on register | The merchant owner pays its own PDA rent. Fund it before registering. |
| `no matches found: https://...` | zsh globbing the `?` in the URL. Quote it. |
| `Test validator does not look started` | Read `.anchor/test-ledger/test-ledger-log.txt` — it names the real reason. |
