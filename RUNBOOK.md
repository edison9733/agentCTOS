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

Expect **14 passing** in about two and a half minutes. Two tests genuinely
sleep 62 seconds each — the program enforces a 60-second minimum escrow
timeout, and those tests wait it out to prove the reclaim path really is
time-gated. That's not a
hang.

`anchor test` starts its own local validator, so it costs no devnet SOL and
works offline.

---

## 5. Run the demo

```bash
export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
npm run demo
```

Five acts, ~2.5 minutes. Each states a claim, then proves it with a real
devnet transaction and re-reads the result from the program's own accounts.

**If you hit `429 Too Many Requests`,** the public devnet RPC is throttling
you. Get a free key at [helius.dev](https://helius.dev) and use it instead:

```bash
export ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
npm run demo
```

The quotes matter in zsh — an unquoted `?` is a glob and the shell will refuse
the URL with `no matches found`.

### Presenting it

Act 5 waits out the remaining escrow timeout, which is ~1 minute of a
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

That generates a merchant, pays them 25 tokens under escrow, confirms
delivery, and closes the order record to reclaim its rent — printing both
token balances and the settlement fee along the way.

| Command | What it shows |
|---|---|
| `npm run pay -- --amount 25` | No reserve, no history: full escrow, released on confirmation, 0.50% fee. |
| `npm run pay -- --amount 60 --reserve 100 --register --settle confirm` | Instant payment, backed by real merchant collateral. |
| `npm run pay -- --amount 5 --settle reclaim --timeout 60` | The rug. Merchant never delivers; after 60s the buyer takes the money back **with no merchant signature**, and any instant portion is skimmed from the merchant's own reserve. |
| `npm run pay -- --amount 25 --settle claim` | The merchant claims fulfillment without the buyer confirming, starting the 24-hour dispute window. |
| `npm run pay -- --amount 25 --settle hold` | Leaves the escrow open so you can inspect the vault on Explorer. |

### The rule worth showing

There is no mutual-refund path anymore — it was removed because it let a
buyer walk away penalty-free at the merchant's expense. Every order now
resolves exactly one of two ways: the buyer confirms, or the clock runs out.

```bash
npm run pay -- --amount 5 --settle reclaim --timeout 60
```

A reclaim needs **only the buyer**, but only after the deadline — and it is
also what makes an instant payment collateralized rather than a free pass:
it skims the merchant's own reserve to cover whatever was already paid
instantly.

---

## 7. Verify it independently

Everything the demo prints is re-read from on-chain accounts, but don't take
its word for it. Leave an escrow open and read it yourself:

```bash
npm run pay -- --amount 25 --settle hold
solana account <PAYMENT_PDA> --url devnet
```

The same bytes, from the CLI, with no backend of ours in the path. Open the
vault account beside it on Explorer: its authority is the payment account
itself, not a keypair, which is what "no operator can move the funds" means in
practice.

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
| `insufficient lamports` on `open_reserve` or `register_buyer` | The merchant or buyer pays its own PDA rent. Fund the wallet before calling either. |
| `no matches found: https://...` | zsh globbing the `?` in the URL. Quote it. |
| `Test validator does not look started` | Read `.anchor/test-ledger/test-ledger-log.txt` — it names the real reason. |
