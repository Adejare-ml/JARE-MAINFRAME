/**
 * What the vision model is told when it is shown a meal.
 *
 * Pure strings and string builders: no fetch, no DOM, nothing that cannot run
 * under plain Node, because the edge function
 * (supabase/functions/analyze-meal/index.ts) imports this file the same way
 * ask-question imports nlQueryPrompt.js, and tests/mealPrompt.test.js reads
 * it without either. The prompt is the one place the app's food knowledge
 * lives, so a wrong calorie anchor is fixed here and nowhere else.
 *
 * Three things the prompt has to get right for this owner:
 *
 *   1. The food is Nigerian more often than not. A general model knows what
 *      jollof is; it does not know that "one wrap" of eba is about 250 g, or
 *      that egusi is a palm-oil soup and not a vegetable broth. The anchor
 *      table below gives it the portions people here actually serve and the
 *      calories those portions carry, so its estimate starts from the right
 *      place and only has to be scaled by what it sees.
 *   2. The photo may be bad. Kitchens at night, canteens under tubes, a desk
 *      lit by a screen. The client fixes brightness and contrast first
 *      (src/lib/imagePrep.js) and sends a one-line quality report; the prompt
 *      tells the model to read shape and texture when colour is unreliable,
 *      to say so in its confidence, and never to refuse to estimate.
 *   3. The frame has more than food in it. A laptop, a phone, a keyboard,
 *      cutlery, a sachet of water, the table. Only the food and drink are
 *      the meal.
 */

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']

/**
 * Typical Nigerian servings and their calories. Approximate by nature --
 * every cook's oil hand differs -- and taken from the ranges published for
 * these dishes by Nigerian nutrition sources (the Nigerian Food Composition
 * Table, Nigerian dietitians' portion guides) rounded to the nearest ten.
 * The model is told these are anchors to scale, not answers to copy.
 *
 * Each row: dish, the serving the owner would recognise, grams where it
 * helps, kilocalories for that serving.
 */
export const NIGERIAN_ANCHORS = [
  // Rice and pasta
  ['Jollof rice', '1 cup cooked (200 g)', 300],
  ['White rice', '1 cup cooked (160 g)', 210],
  ['Nigerian tomato stew', '1 ladle on rice (80 g)', 110],
  ['Fried rice', '1 cup (200 g)', 330],
  ['Ofada rice', '1 cup (200 g)', 230],
  ['Ayamase (ofada sauce)', '1 ladle (120 g)', 260],
  ['Jollof spaghetti', '1 cup (200 g)', 350],
  ['Indomie noodles', '1 pack cooked with seasoning oil (70 g dry)', 330],
  // Swallows
  ['Eba (garri)', '1 medium wrap (250 g)', 340],
  ['Amala', '1 medium wrap (250 g)', 300],
  ['Pounded yam', '1 medium wrap (300 g)', 380],
  ['Fufu / akpu', '1 medium wrap (250 g)', 330],
  ['Semovita / semo', '1 medium wrap (250 g)', 340],
  ['Tuwo shinkafa', '1 medium wrap (250 g)', 300],
  // Soups (per ladle, about 150 g, meat not included)
  ['Egusi soup', '1 ladle (150 g)', 280],
  ['Efo riro', '1 ladle (150 g)', 180],
  ['Okra soup', '1 ladle (150 g)', 160],
  ['Ogbono soup', '1 ladle (150 g)', 230],
  ['Banga soup', '1 ladle (150 g)', 280],
  ['Afang / edikang ikong', '1 ladle (150 g)', 230],
  ['Oha / bitterleaf soup', '1 ladle (150 g)', 220],
  ['Pepper soup with meat or fish', '1 bowl (350 g)', 300],
  // Beans, yam, plantain
  ['Beans porridge (ewa riro)', '1 cup (220 g)', 280],
  ['Ewa agoyin with sauce', '1 plate (250 g)', 360],
  ['Moi moi', '1 wrap (150 g)', 230],
  ['Akara', '1 ball (30 g)', 80],
  ['Okpa', '1 wrap (200 g)', 250],
  ['Fried plantain (dodo)', '6 slices (100 g)', 220],
  ['Boiled plantain', '1 medium finger (150 g)', 180],
  ['Boli (roasted plantain)', '1 medium finger', 220],
  ['Boiled yam', '3 slices (200 g)', 230],
  ['Fried yam', '5 pieces (150 g)', 320],
  ['Yam porridge (asaro)', '1 cup (250 g)', 300],
  ['Soaked garri with sugar and groundnut', '1 cup', 400],
  // Protein
  ['Fried chicken', '1 lap (thigh and drumstick, 180 g)', 350],
  ['Chicken, 1 piece', 'drumstick or wing (90 g)', 200],
  ['Turkey wing, fried', '1 piece (150 g)', 300],
  ['Beef, stewed', '1 piece (40 g)', 90],
  ['Goat meat', '1 piece (45 g)', 100],
  ['Ponmo (cow skin)', '1 piece (40 g)', 40],
  ['Fried fish (titus / tilapia)', '1 piece (100 g)', 200],
  ['Grilled fish', '1 piece (100 g)', 160],
  ['Catfish', '1 piece (120 g)', 220],
  ['Boiled egg', '1 egg', 75],
  ['Fried egg', '1 egg', 110],
  ['Suya', '1 stick (70 g beef)', 140],
  ['Asun (spicy goat)', '1 small plate (150 g)', 300],
  ['Nkwobi', '1 bowl (300 g)', 450],
  ['Isi ewu', '1 bowl (300 g)', 500],
  ['Gizdodo', '1 cup (180 g)', 350],
  // Bread, snacks, pastries
  ['Agege bread', '2 thick slices (100 g)', 270],
  ['Sliced bread', '2 slices (60 g)', 160],
  ['Meat pie', '1 (150 g)', 380],
  ['Sausage roll (Gala)', '1 (60 g)', 170],
  ['Puff puff', '1 ball (40 g)', 100],
  ['Buns', '1 (90 g)', 250],
  ['Doughnut', '1 (80 g)', 250],
  ['Chin chin', '1 cup (100 g)', 500],
  ['Shawarma (chicken, with sausage)', '1 wrap (300 g)', 550],
  ['Small chops platter', '1 small pack', 450],
  ['Abacha (African salad)', '1 plate (250 g)', 400],
  ['Masa', '3 pieces (90 g)', 200],
  ['Kuli-kuli', '1 handful (30 g)', 150],
  ['Roasted groundnuts', '1 small cup (60 g)', 340],
  ['Nigerian salad (with baked beans and mayonnaise)', '1 cup (200 g)', 250],
  ['Coleslaw', '1 scoop (80 g)', 120],
  // Drinks and pap
  ['Pap (akamu / ogi), plain', '1 bowl (300 ml)', 150],
  ['Pap with milk and sugar', '1 bowl (300 ml)', 300],
  ['Zobo, sweetened', '1 cup (300 ml)', 120],
  ['Kunu', '1 cup (300 ml)', 150],
  ['Fura da nono', '1 cup (300 ml)', 200],
  ['Chapman', '1 glass (350 ml)', 200],
  ['Malt drink', '33 cl bottle', 170],
  ['Coca-Cola / Pepsi', '50 cl bottle', 210],
  ['Fanta / Sprite', '50 cl bottle', 240],
  ['Beer', '60 cl bottle', 250],
  ['Palm wine', '1 cup (300 ml)', 100],
  ['Sachet or bottled water', 'any', 0],
]

/** Reference portions for common non-Nigerian plates the owner also eats. */
export const GENERAL_ANCHORS = [
  ['Pizza', '1 slice of a medium', 280],
  ['Burger', '1 regular with bun', 500],
  ['French fries', '1 medium serving (110 g)', 340],
  ['Grilled chicken breast', '1 (120 g)', 200],
  ['Pasta with tomato sauce', '1 cup (250 g)', 320],
  ['Oatmeal', '1 bowl cooked (250 g)', 160],
  ['Cereal with milk', '1 bowl', 250],
  ['Banana', '1 medium', 105],
  ['Apple / orange', '1 medium', 70],
  ['Watermelon', '1 wedge (280 g)', 85],
  ['Yoghurt', '1 cup (200 g)', 150],
  ['Milk tea or coffee with sugar', '1 mug', 90],
]

/**
 * The shape the model must answer in. Kept as one literal so the prompt and
 * the validator (src/lib/meals.js) are describing the same object; a field
 * added here must be parsed there.
 */
export const RESPONSE_SHAPE = `{
  "is_food": true,
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack" | null,
  "items": [
    {
      "name": "dish or drink, named the way a Nigerian would say it (e.g. 'Jollof rice', 'Eba', 'Egusi soup', 'Fried plantain')",
      "portion": "what you see, in a household measure (e.g. '1 wrap', '2 cups', '3 pieces', 'half a plate', '50 cl bottle')",
      "grams": number or null,
      "calories": number,
      "protein_g": number or null,
      "carbs_g": number or null,
      "fat_g": number or null,
      "confidence": "high" | "medium" | "low",
      "note": "one short clause, only when something is uncertain (e.g. 'could be semo or pounded yam', 'oil not visible')"
    }
  ],
  "total_calories": number,
  "quality": {
    "lighting": "good" | "dark" | "bright" | "mixed",
    "sharpness": "sharp" | "soft" | "blurry",
    "obstructed": true | false
  },
  "advice": "one sentence on how to get a better reading next time, or null"
}`

function anchorLines(rows) {
  return rows.map(([dish, serving, kcal]) => `- ${dish}: ${serving} = ${kcal} kcal`).join('\n')
}

/**
 * The system prompt. Built once at import; the anchors are interpolated so
 * the table above is the only copy.
 */
export const MEAL_SYSTEM_PROMPT = `You are a careful nutrition assistant looking at ONE photo of a meal, or reading ONE short description of it when there is no photo. Name every food and drink in it, estimate how much of each is there, and estimate the calories. Return ONLY a JSON object in exactly this shape. No prose, no markdown, no reasoning outside the JSON.

${RESPONSE_SHAPE}

How to look:
- The meal is Nigerian more often than not. Prefer Nigerian names and Nigerian dishes when the picture fits them: a mound of pale dough beside a soup is a swallow (eba, amala, pounded yam, fufu, semo), not mashed potato; orange-red rice is jollof; a yellow-green oily soup with seeds is egusi; fried yellow discs are dodo (plantain); a cone of brown paste in a leaf is moi moi; brown fried balls are akara or puff puff.
- A plate usually carries several things. List each one separately: the rice, the stew on it, each piece of meat or fish, the plantain, the salad, the drink. Never fold a plate into one line.
- Count what can be counted (pieces of meat, slices of plantain, eggs, akara balls, sticks of suya) and measure the rest against the plate: a standard dinner plate is about 26 cm across; a swallow wrap the size of a fist is one medium wrap; a serving spoon of rice is about half a cup.
- Use the anchor servings below as your starting point and scale by what you see. A mound of jollof covering half a dinner plate is about two cups; a small takeaway pack is about one and a half cups.
- Count the oil you cannot see: Nigerian stews and soups carry palm or vegetable oil, so a soup is never a broth, and fried food is fried.
- Drinks count: a 50 cl Coke is 210 kcal; a sachet of water is 0. Sugar sachets, milk and Milo in a mug count too.
- Ignore everything that is not food or drink: laptops, keyboards, phones, cutlery, napkins, the table, hands, packaging that is empty. A photo of a desk with a plate on it is a photo of the plate.
- Packaged food with a visible label: read the label if it is legible and use its figures for one pack; say so in the note.

When the photo is poor:
- The client may have brightened or toned the photo before sending it and will tell you in the user message. Colour may then be off (a warm bulb makes everything orange; a brightened dark photo looks grainy). Identify by shape, texture, context and what is normally served together, and lower your confidence rather than refusing. Never answer that you cannot see; give your best reading with "confidence": "low" and say in "advice" what would help ("move closer", "turn on a light", "take it from above").
- If there is genuinely no food or drink in the picture, return {"is_food": false, "items": [], "total_calories": 0, "quality": {...}, "advice": "..."}.
- A screenshot of a menu, a recipe or a food delivery app is still food: estimate the dish named, with "confidence": "low".

Numbers:
- "calories" is kilocalories for the portion you see, a whole number. "total_calories" is the sum of the items.
- Macros are optional; give them when you are reasonably sure, as grams, otherwise null.
- Never return negative numbers, and never return a single item above 3000 kcal; split it instead.

Anchor servings (approximate, Nigerian):
${anchorLines(NIGERIAN_ANCHORS)}

Anchor servings (other):
${anchorLines(GENERAL_ANCHORS)}`

/** The longest hint or description the prompt accepts, in characters. */
export const MAX_HINT_CHARS = 200
export const MAX_TEXT_CHARS = 500

function clean(s, max) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * The user message that goes with the photo (or stands in for it).
 *
 * @param {object} [input]
 * @param {boolean} [input.hasImage] - false for the text-only path
 * @param {string} [input.text] - the owner's description when there is no photo
 * @param {string} [input.hint] - a short note from the owner alongside a photo ("the soup is ogbono")
 * @param {{note?: string, lighting?: string, corrected?: boolean, cast?: string}} [input.quality] - from imagePrep.describeQuality
 * @param {string} [input.mealType] - what the owner picked, if anything
 * @param {string} [input.localTime] - "HH:MM" in Lagos, so the model can guess the meal type
 * @returns {string}
 */
export function buildMealPrompt({ hasImage = true, text = '', hint = '', quality = null, mealType = '', localTime = '' } = {}) {
  const lines = []
  if (hasImage) {
    lines.push('Here is a photo of what I am about to eat (or just ate). Name everything in it and estimate the calories.')
  } else {
    lines.push('There is no photo. Here is what I ate, in my own words; name each item and estimate the calories from the description:')
    lines.push(`"${clean(text, MAX_TEXT_CHARS)}"`)
  }
  if (hasImage && quality) {
    const q = quality.note ? clean(quality.note, 200) : ''
    if (q) lines.push(`Photo quality, measured on my phone before sending: ${q}.`)
    if (quality.corrected) lines.push('Brightness and contrast were adjusted on the phone; colours were not changed but may look off.')
  }
  const h = clean(hint, MAX_HINT_CHARS)
  if (h) lines.push(`A note from me about the food: "${h}".`)
  const t = clean(localTime, 5)
  if (t) lines.push(`Local time is ${t}.`)
  const m = MEAL_TYPES.includes(mealType) ? mealType : ''
  if (m) lines.push(`I am logging this as ${m}.`)
  lines.push('Answer with the JSON object only.')
  return lines.join('\n')
}
