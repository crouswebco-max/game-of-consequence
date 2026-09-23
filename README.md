# A Game of Consequence

A murder mystery for a projector and everyone's phones. No board, no cards, no
box on the table — the wall holds the house and the public drama, each phone
holds one person's hand, notebook and voice.

Classic Cluedo rules on an original board: a hidden person, weapon and room;
two dice and corridors walked square by square; suggestions the table must
disprove; secret passages; one accusation each, and getting it wrong ends your
night. Original cast, house and floor plan, so it is yours to share.

---

## Running it

1. Double-click **`Start the game.command`**.
2. The projector page opens in your browser. Press **F** for fullscreen and cast
   it to the projector.
3. Everyone scans the QR code with their phone camera, or types the address
   underneath it. Same Wi-Fi is the only requirement.
4. Each person types a name and picks a character.
5. Click **Begin the evening** on the projector once everyone is in.

Three to six detectives. Short-handed? Click **Add a stand-in** on the
projector to fill a seat with a computer player — so one real person and two
stand-ins is a game. If nothing happens when you double-click, you need Node
from [nodejs.org](https://nodejs.org) — the script will say so.

Prefer a terminal? `node server.js` in this folder, then open
`http://localhost:7373/`.

### Friends who aren't on your Wi-Fi

Double-click **`Start online game.command`** instead. It opens a secure public
link to your Mac (a "tunnel"), and the QR code on the projector points at it, so
friends can join on their own mobile data from anywhere. It uses `cloudflared`
if you have it, otherwise `ngrok`. If you have neither:

```
brew install cloudflared
```

The host controls (start, reset, add stand-ins) only ever work on your own Mac.
Anyone reaching the game through the public link is sent to the join page.

---

## Running it on AWS (a cloud server)

To play without anyone's Mac running the game, put it on an **Amazon EC2** instance. Everyone joins through the server's public address, and the host opens the projector screen with a password.

1. In the EC2 console (I use **Europe (London)**), click **Launch instance**:
   - **Name:** `consequence`
   - **AMI:** Amazon Linux 2023
   - **Instance type:** a free-tier one, like `t3.micro`
   - **Key pair:** "Proceed without a key pair" (you can still connect with EC2 Instance Connect)
   - **Network settings:** allow **HTTP traffic from the internet**
   - **Advanced details → User data:** paste the whole of [`aws/ec2-user-data.sh`](aws/ec2-user-data.sh), after changing `HOST_PASSWORD` to your own secret
2. Launch it and wait about 2 minutes, until the instance is **Running** with **2/2 checks passed**.
3. Copy the instance's **Public IPv4 address**.
4. **Projector (host):** open `http://<public-ip>/?host=<your password>`
5. **Players:** scan the QR code on the projector, or open `http://<public-ip>/join`

**Stop or terminate the instance when the game is over.** A free-tier instance is free for a limited number of hours, and after that it costs money for every hour it runs.

On a server there's no "this Mac", so the host is recognised by the password in `CONSEQUENCE_HOST_PASSWORD` instead. Without the password, anyone opening the main address is sent to the player page.

## How a turn goes

At the start of your turn your phone offers:

- **Roll the dice** — two dice; walk up to that many squares along the corridors,
  no diagonals. Other pawns block the way. Stepping through a door into a room
  ends your move, whatever is left on the dice. Tap a glowing square on the phone
  map, tap **Walk into…**, or use **Head towards…** to go as far as you can
  towards a room.
- **Take the secret passage** — from a corner room, straight to the opposite
  corner, no roll.
- **Stay and suggest** — if someone's suggestion dragged you into a room since
  your last turn, you may suggest there without moving.
- **Make a formal accusation** — at any point in your turn.

Once in a room you entered this turn, make a **suggestion**: a person and a
weapon, in the room you are standing in. The person and weapon are dragged into
the room. Going clockwise, the first player holding any of the three must show
you one, privately, on your phone. The projector says a card changed hands —
never which.

If nobody can disprove it, the wall goes red. That is the loudest moment in the
game.

An **accusation** is final. Right, and the envelope opens and you win. Wrong,
and you are out of the running — but you keep your cards and still have to
answer everyone else's suggestions.

---

## The board

An original 24×24 floor plan of Hollowmere House: nine rooms round the edge, the
locked stairwell in the middle where the envelope waits, 23 doors, and six
starting squares on the outer edge. Two secret passages join opposite corners —
Study to Kitchen, Lounge to Conservatory. The whole plan is in `board.js`.

---

## Stand-ins

A stand-in takes a free character, is dealt a real hand, and plays its own
turns. It rolls, moves toward rooms it has not ruled out, suggests, disproves
when it must, and accuses when it is certain of all three. It can win.

It is not cheating: a stand-in decides using `publicState()` and its own
`privateState()` and nothing else — exactly what the person holding that phone
would see. There is a test that holds this to account, because an opponent that
quietly knows the answer is not an opponent.

When it disproves, it prefers to show you a card it has already shown you,
since every new card handed over is a fact given away.

They pause between moves so the table can follow. If that feels slow or
fidgety:

```
CONSEQUENCE_BOT_PACE=0.5 node server.js    # half the pause
CONSEQUENCE_BOT_PACE=2 node server.js      # twice the pause
```

A real person always outranks a stand-in — if someone joins a full table, a
stand-in gives up its seat.

---

## Sound

All the music and effects are generated live in the browser, so there are no
files to download and nothing needs the internet:

- Lobby: a winding-down music box over a low organ drone.
- When everyone has picked a character: a thunderclap, a manic laugh and
  "Good luck… you'll need it."
- During play: a quieter drone, wind through the house, stray piano notes, and
  now and then thunder or the hall clock.
- Effects: dice, footsteps as pawns walk, creaking doors, cards sliding, the
  passage grinding open, a string stab for suggestions, a gong for a wrong
  accusation, bells for a solved case. Phones play their own dice and card
  sounds when you tap.

The browser only allows sound after a click, so click the projector page once.
Hover over the bottom of the projector for a **music volume** slider and a
**sound on/off** button.

**Voices.** Double-click `tools/record-voices.command` to record the laugh and
each suspect saying their name ("Major Aldous Thorne. At your service.") with
your Mac's built-in voices. Until those recordings exist, the game speaks the
lines with the device's own voice instead.

---

## What makes it feel like the board game

- **Cutscenes.** An opening in the storm, a chalk outline drawing itself, the
  six guests dealt as cards, the envelope sealed with wax; two 3D dice thrown
  across baize; double doors swinging open onto each room; a tunnel for secret
  passages; an interrogation with the accused dropping into a spotlight; and
  the accusation, cards turning over one by one before the stamp comes down. The host can click a scene to skip it. Stand-ins wait
  for a scene to finish before they move, so the story and the game stay in step.
- **Dice.** A real die tumbles on the projector and on your phone.
- **The detective notepad.** The classic sheet on your phone: every person,
  weapon and room down the side, a column for each player. Tap boxes to mark
  who has what. Your own cards fill in automatically, a card shown to you gets
  ticked in that player's column, and when someone can't answer a suggestion,
  everyone's notepad gets those three crossed off — the whole table saw it.
- **A walking board.** Portrait pawns walk the corridors square by square;
  squares you can reach glow for whoever is moving.
- **The case file.** On your phone, suspects are manila dossiers with photos;
  your cards are evidence tags; the map is in your hand.
- **Rules** on the projector's lobby and on a Rules tab on every phone.
- **Secret cards** you tap to turn over, and a buzz when it's your move (on
  phones that support vibration).

---

## The board

Nine rooms on a three-by-three grid rather than the original corridor maze: it
reads at ten feet across a room, and it keeps turns short. Move orthogonally,
as many rooms as you rolled. The four corners are joined by two secret
passages — the Study to the Kitchen, the Lounge to the Conservatory.

---

## What is kept secret, and how

The server holds one copy of the game. It builds two different views of it:

- `publicState()` — the projector and every phone. Positions, whose turn it is,
  what was suggested, that a card was shown. Never a hand, never the envelope.
- `privateState(pid)` — one phone. That person's cards, their notebook, and
  whatever has been shown to them.

Both live in `game.js`, next to each other, so there is one place to check. The
envelope is a field on the game object that no public view reads until the game
is over. `test/playtest.js` plays a whole game over real HTTP with four
simulated phones and then audits every payload each one received, which is the
part worth re-running if you change anything.

---

## Files

```
game.js                the rules, and the only place the solution lives
board.js               the floor plan, doors, passages and pathfinding
server.js              HTTP + server-sent events, Node standard library only
public/board.html      the projector
public/phone.html      the phone
public/theme.css       design tokens, shared by both screens
public/qr.js           a small QR encoder, so joining needs no internet
public/sound.js        music and sound effects, synthesised live
tools/record-voices.command   records the spoken lines with your Mac's voices
Start online game.command     host for friends anywhere, via a tunnel
public/rooms/          nine rooms, full size and grid tiles
public/portraits/      the six characters
public/audio/          twenty-three narration clips
test/rules.test.js     45 checks: board, movement, rules, notepad, stand-ins
test/playtest.js       four phones play a full game, then a leak audit
test/solo.test.js      one person and three stand-ins, then a leak audit
test/shots.js          renders both screens in a real browser to look at
```

Run all three: `node test/rules.test.js`, `node test/playtest.js`,
`node test/solo.test.js`.

---

## Changing things

**The cast, the weapons, the rooms** are three arrays at the top of `game.js`.
Rename anyone; the rest of the game follows. Room ids map to image and audio
filenames, so a new room id wants `public/rooms/<id>.jpg`,
`public/rooms/<id>-tile.jpg` and, if you like, `public/audio/room-<id>.mp3`.

**The look** is in `public/theme.css`, in the `:root` block at the top. Both
screens read from it, so they cannot drift apart.

**The board shape** is `board.js`: room rectangles, doors, starts and
passages. Movement and pathfinding are derived from it; the tests check every
room can be reached from every starting square.

---

## Known edges

- The narration is the bundled British voice, trimmed from longer takes. There
  is no clip for a wrong move or a passed turn — the wall stays quiet there.
- Fonts come from Google Fonts. With no internet at the venue they fall back to
  system serifs, which on a Mac look close enough that most people will not
  notice. Bundle them locally if you want to be certain.
- No turn timer, and no grace period if a phone drops — a refresh rejoins, since
  the phone remembers its seat.
- Stand-ins can only be added before the game begins, so a phone that dies
  mid-game cannot be handed over to one.
- The projector is the host: it can start and reset, and nothing else can.
  Anyone who opens the projector page on the same network gets those controls,
  which is fine in a living room and not fine anywhere else.
