# Running the demo, and what to test it with

Two parts: how to get real state on chain so the site has something to show,
and how to actually present it.

---

## 1. Wallets and addresses

### What is already fixed

| Thing | Value |
|---|---|
| Program | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` |
| Cluster | Solana **devnet** |
| Program on Solscan | https://solscan.io/account/HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4?cluster=devnet |

### What is generated fresh every run

The demo deliberately generates the buyer and both merchants per run and
throws them away afterwards. That is not laziness — it is what makes the
first act honest. `BuyerStanding` is keyed only by buyer pubkey, so a
persistent buyer would carry standing between runs and act 2's claim
("this buyer has zero settled orders") would quietly become false.

So there is no fixed buyer address to hand out. The addresses appear in the
demo output and on `#/collateral` as each run creates them.

### The one wallet you must fund

Only the wallet that *pays* needs to persist:

```bash
solana-keygen new -o demo-wallet.json
solana airdrop 2 $(solana-keygen pubkey demo-wallet.json) --url devnet
solana balance $(solana-keygen pubkey demo-wallet.json) --url devnet
```

Budget roughly **0.08 SOL per demo run** — a fresh mint, six token accounts,
the PDAs, plus funding the throwaway buyer and two merchants. Keep 1–2 SOL in
it for a presentation day.

If airdrops are rate-limited (they will be), mine devnet SOL instead:

```bash
cargo +stable install devnet-pow
devnet-pow mine -d 3 --reward 0.02
```

### Making the site show something

`#/collateral` reads real accounts. On a fresh devnet it is legitimately
empty, and it will say so. To populate it:

```bash
npm run demo                      # full five acts, ~90 seconds
npm run pay -- --amount 25 --reserve 100 --register --settle hold
```

`--settle hold` is the useful one for a static display: it opens a reserve,
pays an order, and **leaves the escrow open**, so the page shows a live
`escrow held` order with a real countdown rather than only settled history.

To show the rug specifically:

```bash
npm run pay -- --amount 5 --settle reclaim --timeout 60
```

---

## 2. How to present this

### The one-sentence framing

> Everyone else is building ways to check whether a merchant is trustworthy.
> We made it so you don't have to care.

### The narrative, in the order that lands

**Open on the failure, not the feature.** Do not start with architecture.
Start with: *an agent pays a stranger $40 and the stranger vanishes.* Every
person in the room already knows there is no chargeback. Let that sit.

**Then the number.** 167M x402 transactions settled, ~$28K/day of real
commerce, $0.20 average, roughly half of it gamified. The rails work and the
money is not moving — because nobody sends real value to a stranger with no
recourse. This is the whole reason your thing should exist, and it is somebody
else's data, which makes it credible.

**Then the mechanism, in one breath.** The merchant posts its own money. That
bond is the ceiling on what it can be paid instantly. If it doesn't deliver,
the buyer takes the escrow back *and* skims the instant part out of that bond,
without the merchant's signature. No identity, no score, nothing to fake.

**Then prove it.** This is where the demo goes.

### What to actually show, and in what order

Do **not** run the terminal demo live if you can avoid it — it takes 90
seconds, 60 of which is a timeout, and a bad venue wifi ruins it. Instead:

1. **Open `#/collateral` on the projector.** Real reserves, real orders, live
   from devnet. Say: *"this is the actual chain, not a mockup."*
2. **Click one Solscan link.** This is the single highest-trust moment in the
   whole pitch. You are handing the audience third-party verification of your
   own claim. Do it deliberately, don't rush past it.
3. **Play the recorded run** (see below), or open `live.html` and hit Run if
   you have the network for it and want the risk.
4. **Land on act 5.** The buyer recovered the full 40 tokens, the rugger's
   reserve went to zero, and *there is no merchant signature in that
   transaction.* That sentence is your closer.

### Recording the terminal run

```bash
brew install asciinema agg
asciinema rec demo.cast --idle-time-limit=2 -c "npm run demo"
agg demo.cast demo.gif
```

`--idle-time-limit=2` is the flag that matters: act 5 waits out a real
60-second escrow timeout, and without this the recording contains a full
minute of nothing. With it, the wait becomes a beat.

### The question you will be asked, and the answer

**"What stops a merchant posting collateral, building trust, then rugging for
more than the bond?"**

Nothing — and that is the design, not a hole in it. The loss is *bounded by
the bond*, it is not prevented. A merchant can always steal up to what it has
staked, and then it has lost the stake. The claim is not "rugs are impossible";
it is "the maximum a rug can take is a number the buyer can see before paying."
Say that plainly. Trying to claim more invites someone to find the case where
it breaks.

**"Why not just use reputation?"** Because reputation is exactly the thing an
agent cannot verify cheaply and an attacker can manufacture. Collateral cannot
be faked — it is either in the vault or it isn't.

### What not to oversell

- It is on **devnet**, not mainnet. Say so before someone asks.
- It has had **no external audit**. Slide 10 already says this; saying it out
  loud is worth more than hoping nobody checks.
- The dispute window (`claim_fulfillment` / `finalize_claim`) passes tests but
  has never been run adversarially at scale.

Naming your own gaps before a judge finds them reads as competence. Getting
caught claiming more than you built does not.
