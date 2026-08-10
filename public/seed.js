/* ============================================================
   Demo seed data — one copy, used by two very different callers.

   The Node server requires this to build the hosted demo account, and
   the browser loads it directly for the static GitHub Pages build. UMD
   wrapper because it has to work as both a CommonJS module and a plain
   <script>. Keeping it in one file means the two demos can't drift.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoachDeskSeed = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /** Days from today at a given hour, as an ISO string. */
  function at(dayOffset, hour, minute) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute || 0, 0, 0);
    return d.toISOString();
  }

  /**
   * @param {() => string} uid  id generator supplied by the caller
   */
  function buildSeed(uid) {
    const id = { maya: uid(), jacob: uid(), daniel: uid(), amara: uid(), leo: uid(), priya: uid() };

    const clients = [
      { id: id.maya, name: "Maya Chen", phone: "555-0142", email: "maya.chen@example.com",
        tags: ["tennis", "competitive"], isMinor: false, guardian: null, consent: null,
        fields: { Level: "Advanced", Goal: "Consistent backhand under pressure", Handedness: "Right" },
        notes: [
          { id: uid(), at: at(-2, 17), text: "Backhand slice much steadier. Still dropping the shoulder on high balls, drilled it for twenty minutes." },
          { id: uid(), at: at(-9, 17), text: "First session back after the wrist strain. Kept it light, no overheads." }
        ], created: at(-120, 9) },

      { id: id.jacob, name: "Sam Rivera", phone: "555-0119", email: "",
        tags: ["tennis", "intermediate"], isMinor: false, guardian: null, consent: null,
        fields: { Age: "19", Level: "Intermediate", Goal: "Break into the college club team" },
        notes: [{ id: uid(), at: at(-4, 16), text: "Serve toss goes to pieces when he's tired. Worth filming next week." }],
        created: at(-31, 9) },

      // Consent on file — the good path.
      { id: id.leo, name: "Leo Park", phone: "555-0188", email: "",
        tags: ["swimming", "junior"], isMinor: true,
        guardian: { name: "Hana Park", contact: "555-0177" },
        consent: { obtained: true, at: at(-60, 10), method: "Signed form" },
        fields: { Age: "16", Event: "200m freestyle", "Best time": "2:04.8" },
        notes: [{ id: uid(), at: at(-3, 7), text: "Turns are costing him nearly a second each. Wall work every session until it sticks." }],
        created: at(-64, 9) },

      // Consent missing — this is what the warning banner is for.
      { id: id.amara, name: "Amara Okafor", phone: "555-0165", email: "",
        tags: ["athletics", "junior"], isMinor: true,
        guardian: { name: "Chidi Okafor", contact: "chidi.okafor@example.com" },
        consent: { obtained: false },
        fields: { Age: "15", Event: "400m" },
        notes: [], created: at(-8, 9) },

      { id: id.daniel, name: "Daniel Ortiz", phone: "", email: "d.ortiz@example.com",
        tags: ["executive", "leadership"], isMinor: false, guardian: null, consent: null,
        fields: { Focus: "Communicating under pressure", Company: "Northwind Logistics" },
        notes: [{ id: uid(), at: at(-6, 11), text: "Wants to work on running a room when he's the most junior person in it." }],
        created: at(-45, 9) },

      { id: id.priya, name: "Priya Nair", phone: "555-0101", email: "",
        tags: ["swimming", "beginner"], isMinor: false, guardian: null, consent: null,
        fields: { Goal: "Comfortable in deep water by spring" },
        notes: [], created: at(-12, 9) }
    ];

    const events = [
      { id: uid(), title: "Lesson",   clientId: id.maya,   start: at(0, 16),     durationMin: 60, location: "Court 3", notes: "" },
      { id: uid(), title: "Lesson",   clientId: id.jacob,  start: at(0, 17, 30), durationMin: 60, location: "Court 1", notes: "" },
      { id: uid(), title: "Session",  clientId: id.daniel, start: at(1, 10),     durationMin: 45, location: "Zoom",    notes: "Prep for the board update" },
      { id: uid(), title: "Lesson",   clientId: id.leo,    start: at(1, 7),      durationMin: 90, location: "Lane 4",  notes: "" },
      { id: uid(), title: "Lesson",   clientId: id.priya,  start: at(2, 18),     durationMin: 30, location: "Pool",    notes: "" },
      { id: uid(), title: "Practice", clientId: id.amara,  start: at(3, 16),     durationMin: 60, location: "Track",   notes: "" },
      { id: uid(), title: "Lesson",   clientId: id.maya,   start: at(4, 16),     durationMin: 60, location: "Court 3", notes: "" },
      { id: uid(), title: "Lesson",   clientId: id.jacob,  start: at(7, 17, 30), durationMin: 60, location: "Court 1", notes: "" },
      // A little history so the calendar isn't only forward-looking.
      { id: uid(), title: "Lesson",   clientId: id.maya,   start: at(-2, 16),    durationMin: 60, location: "Court 3", notes: "" },
      { id: uid(), title: "Lesson",   clientId: id.leo,    start: at(-3, 7),     durationMin: 90, location: "Lane 4",  notes: "" },
      { id: uid(), title: "Session",  clientId: id.daniel, start: at(-6, 11),    durationMin: 45, location: "Zoom",    notes: "" }
    ].map(function (e) { e.source = "local"; return e; });

    const profile = {
      name: "Alex Rivera", title: "Tennis & Performance Coach",
      email: "alex@example.com", phone: "555-0100",
      location: "Austin, TX", website: "alexrivera.example.com",
      bio: "Fifteen years coaching juniors and adults, from first-serve nerves to regional finals. I coach the player, not just the stroke. Most of the work is making good habits survive pressure.",
      tagline: "Private Tennis Coaching",
      offer: "First session free",
      specialties: ["Junior development", "Serve mechanics", "Match strategy", "Return to play after injury"],
      experience: [
        { id: uid(), role: "Head Coach", org: "Riverside Tennis Club", period: "2019 to present",
          detail: "Run the junior programme: forty players across four squads. Six have gone on to state level in the last three years." },
        { id: uid(), role: "Assistant Coach", org: "Lakeside Academy", period: "2014 to 2019",
          detail: "Adult clinics and one-to-one coaching." }
      ],
      certifications: [
        { id: uid(), name: "USPTA Elite Professional", issuer: "USPTA", year: "2018" },
        { id: uid(), name: "Level 2 Strength & Conditioning", issuer: "NSCA", year: "2021" },
        { id: uid(), name: "Safeguarding in Youth Sport", issuer: "SafeSport", year: "2024" }
      ],
      testimonials: [
        { id: uid(), quote: "My daughter went from dreading matches to asking for extra sessions. Alex reads people as well as he reads a serve.", author: "Parent, junior squad" },
        { id: uid(), quote: "Practical, patient, and honest about what needs work. Worth every session.", author: "Daniel O., adult programme" }
      ]
    };

    return { clients: clients, events: events, profile: profile };
  }

  return { buildSeed: buildSeed, at: at };
});
