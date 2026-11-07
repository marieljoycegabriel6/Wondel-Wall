# 💡 Wonder Wall

A live sticky-note wall for your classroom.

1. **Teacher** creates a wall for a lesson (title + question).
2. The wall shows a **QR code** and a 5-letter code on the big screen.
3. **Students** scan it with their phone or tablet and **type** or **write/draw** a note, then tap **Post it!**
4. Notes pop up on the screen **live** as sticky notes. The teacher can drag them around or remove them.
5. Every wall is **saved automatically**. Click **➕ New wall** for the next lesson. Old walls stay in **Saved walls**, where you can reopen them anytime.

## Run it (on the teacher's computer)

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd wonder-wall
npm install
npm start
```

Open **http://localhost:3000** on the teacher's computer and project it on the screen.
Students must be on the **same Wi-Fi**. The QR code already points to your computer's Wi-Fi address.

Lock the teacher pages with a PIN so students can't open them:

```bash
TEACHER_PIN=1234 npm start          # Mac / Linux
set TEACHER_PIN=1234 && npm start   # Windows (cmd)
```

## Put it online (works on any network, including mobile data)

Deploy it to any Node host (Render, Railway, Fly.io, a school server) and set:

- `TEACHER_PIN`: your teacher PIN
- `PUBLIC_URL`: optional, e.g. `https://my-wonder-wall.onrender.com`
- `DATA_DIR`: optional folder where walls are stored. Use a persistent disk on hosts that wipe files on restart.

## Teacher buttons on a wall

| Button | What it does |
|---|---|
| 🔒 Close posting | Stop new notes (e.g. when time is up). Click again to reopen. |
| Hide QR / Big QR | Hide the QR code, or show it full screen so it's easy to scan |
| Full screen | Show the wall in full screen for the projector |
| 🖨 Print / Save PDF | Print the wall, or choose "Save as PDF" |
| 💾 Download | Download all the notes (including drawings) as a backup file |
| ➕ New wall | Go back and create a wall for the next lesson or activity |

Drag a note to move it. Hover over a note and click ✕ to remove it.

Walls are stored as files in the `data/` folder.

## Updating the online site

The Render service is linked to this GitHub repository, so every change pushed to `main` goes live automatically within a couple of minutes (usually 1–2 minutes after the push).
