# What is left, as commands you can paste

Everything below runs on your Mac, in order. Each block is self-contained —
paste the whole block, including the comment lines.

The only block you have to *edit* before pasting is step 1.

---

## 0. Open the repo and set the environment

Paste this once per terminal window. Replace `<HELIUS_KEY>` with your key.

```bash
cd ~/agentCTOS
export ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=<HELIUS_KEY>"
export ANCHOR_WALLET=~/.config/solana/id.json
```

The quotes around the URL matter — zsh treats a bare `?` as a glob.

---

## 1. Put your name and bio on slide 9  ← the one blocking thing

Slide 9 still says **"Replace this with your own two or three lines"** and the
name on slides 1 and 9 is still the placeholder. Edit the five values at the
top of this block, then paste the whole thing:

```bash
cd ~/agentCTOS
python3 - <<'PY'
# ---- edit these five values ----------------------------------------------
NAME    = "Your Name"
TAGLINE = "One line on who you are and why you built this"
BULLETS = [
  "What you have shipped before that makes escrow-holding code a reasonable thing to hand you.",
  "Your Solana, payments, or security background.",
  "Why you care that agent payments end up safe rather than merely fast.",
]
# --------------------------------------------------------------------------

import re, pathlib
p = pathlib.Path("frontend/deck.html")
s = p.read_text(encoding="utf-8")

s = s.replace("Thomas Marcus", NAME)
block = ("<h3>" + TAGLINE + "</h3>\n        <ul>\n"
         + "\n".join("          <li>" + b + "</li>" for b in BULLETS)
         + "\n        </ul>")
s, n = re.subn(r"<h3>Replace this with your own two or three lines</h3>\s*<ul>.*?</ul>",
               lambda m: block, s, flags=re.S)
assert n == 1, "slide 9 block not found (matched %d)" % n
p.write_text(s, encoding="utf-8")
print("slide 9 updated")
PY
```

Keep each bullet to roughly one line of text. Step 2 will warn you if a slide
grew past 720px, which is the point at which content starts getting clipped.

---

## 2. Re-export the deck

The PNGs and PDF currently in `dist/deck/` were exported **before** step 1, so
they still carry the placeholder. Re-run the export:

```bash
cd ~/agentCTOS
npm run export-deck
```

You want to see `10 slides` exported and no `! 09-team is NNNpx tall` warning.
If you do see that warning, shorten a bullet in step 1 and re-run both steps.

---

## 3. Look at what you are about to submit

```bash
open ~/agentCTOS/dist/deck/agent-ctos-deck.pdf
open ~/agentCTOS/dist/deck
```

The PDF is the submission file. The folder holds the ten 2560×1440 PNGs — those
are what you drag into Canva, one per slide, if the deck has to live there.

For Canva: import the ten PNGs as slide backgrounds, then drop `demo.gif` on
top of slide 4 (the demo slide) so the terminal run plays inside the deck
instead of you switching windows.

```bash
open ~/agentCTOS/demo.gif
```

---

## 4. Put fresh state on devnet and check the collateral page

This is the one piece that has been built but never seen against live devnet.
It reads real accounts, so devnet needs something in it first.

```bash
cd ~/agentCTOS
npm run pay -- --amount 25 --reserve 100 --register --settle hold
```

`--settle hold` leaves the escrow **open**, which is what makes the page
interesting — you get a live held order with a real countdown, not just settled
history.

Then serve the site and open the collateral tab:

```bash
cd ~/agentCTOS
npx serve frontend
```

```
http://localhost:3000/index.html#/collateral
```

You should see the reserve you just opened, its vault balance, and the held
order, each linking out to Solscan.

If the page instead says the endpoint is rate-limiting `getProgramAccounts`,
the public RPC is throttling you. Generate a URL that uses your own endpoint
(the encoding matters — a raw `?api-key=` in a query string gets eaten):

```bash
python3 -c "import urllib.parse,sys;print('http://localhost:3000/index.html?rpc='+urllib.parse.quote(sys.argv[1],safe='')+'#/collateral')" "$ANCHOR_PROVIDER_URL" | pbcopy
```

That copies the URL to your clipboard — paste it into the browser. Note it has
your key in the address bar, so don't use that variant while screen-sharing.

---

## 5. Zip the site for the other repo

For handing to the Claude Code session working in `mykh13/agentCTOS`:

```bash
cd ~/agentCTOS
npm run sync-idl
zip -r agentctos-site.zip frontend api idl vercel.json HANDOFF.md WEB.md DEMO.md -x '*.DS_Store'
open .
```

`npm run sync-idl` has to run first — `api/demo.ts` imports
`idl/x402_scoring.json`, which is generated from `target/` and is not in git.

`HANDOFF.md` inside the zip is written for that other session: it says what
changed, what is still simulated (`#/reports`), and what it must not assume.

---

## 6. Commit and push

```bash
cd ~/agentCTOS
git add -A
git commit -m "Fill in the team slide"
git push -u origin claude/x402-solana-scoring-p3yoot
```

`dist/`, `*.zip`, `demo.cast` and `demo.gif` are gitignored, so the exported
deck, the site zip and the recording stay local — deliberate, they are all
build output and regenerable.

---

## Before you present

Read `DEMO.md` section 2. The short version:

1. Open `#/collateral` on the projector. "This is the actual chain."
2. Click one Solscan link, slowly. That is the highest-trust moment you have.
3. Play `demo.gif` rather than running the 90-second live demo on venue wifi.
4. Close on act 5: the buyer got all 40 tokens back, the rugger's reserve went
   to zero, and **there is no merchant signature in that transaction**.

Say "devnet" and "no external audit" yourself, before a judge asks.
