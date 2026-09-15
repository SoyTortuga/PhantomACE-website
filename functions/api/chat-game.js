/* ══════════════════════════════════════════════
   CHAT SCRAMBLE — a game chat plays on the BRB screen.

   Chat is the controller, the overlay is the screen. The bot posts at most
   twice a round: one line when a round opens and one when it closes.

   THE BOT DOES NOT REPLY TO PLAYERS, and that is a hard design rule rather
   than a stylistic one. A non-moderator account is capped at roughly twenty
   chat messages per thirty seconds, and this bot is deliberately not a
   moderator. A game that answered each guess would hit that within seconds
   of a busy round and then go silent — and send-chat.js already documents
   that Twitch reports a filtered message as HTTP 200 with is_sent false, so
   the failure would be invisible. Everything live — the scramble, the clock,
   how many have guessed, the scoreboard — is state the overlay polls.

   THE ANSWER NEVER LEAVES THE SERVER while a round is open. publicState()
   builds what the overlay receives, and the word is not in it. The overlay
   URL is key-protected, but a game whose answer is readable in the page's
   own network tab is not a game.
   ══════════════════════════════════════════════ */

const KEY = 'chat_scramble';
const ROUND_MS = 45000;
const REVEAL_MS = 8000;          // how long the answer stays up between rounds
const WIN_ENTRIES = 2;
const MAX_SCORES = 200;

/* ── The word list ───────────────────────────────────────────────────────
   Four sources, deliberately mixed. The site's own vocabulary so regulars
   have an edge over someone passing through; Magic terms because this is a
   Commander channel and chat already speaks it; video games broadly, which
   is what most of the audience is here for; and a few plain stream words so
   a newcomer is never shut out of a round.

   THE CLUE IS A CATEGORY, ONE WORD. It narrows the field without solving
   the puzzle — "Nintendo" tells you where to look and nothing more. It also
   has to fit beside the scramble on the overlay and inside a single chat
   line, and a sentence does neither.

   RULES FOR ADDING ONE, all enforced by server/scripts/test-chat-game.js:
   four to fifteen letters excluding spaces (beyond fifteen the tiles shrink
   past readability on stream), lower case, letters and single spaces only,
   a one-word category, and a category that does not appear inside its own
   answer.

   Words that need channel context are the ones worth adding by hand — an
   inside joke nobody outside the stream would guess is exactly what makes
   this PhantomACE's game rather than a generic word scramble. */
export const WORDS = [
  { word: 'mana clash', category: 'Site' },
  { word: 'phamily time', category: 'Site' },
  { word: 'dino park', category: 'Site' },
  { word: 'skull clicker', category: 'Site' },
  { word: 'commander bingo', category: 'Site' },
  { word: 'phamshock', category: 'Site' },
  { word: 'memory match', category: 'Site' },
  { word: 'phamathon', category: 'Site' },
  { word: 'mana burn', category: 'Site' },
  { word: 'hot dice', category: 'Site' },
  { word: 'incubator', category: 'Site' },
  { word: 'mutation', category: 'Site' },
  { word: 'marketplace', category: 'Site' },
  { word: 'leaderboard', category: 'Site' },
  { word: 'inventory', category: 'Site' },
  { word: 'showcase', category: 'Site' },
  { word: 'giveaway', category: 'Site' },
  { word: 'hype train', category: 'Site' },
  { word: 'redeem', category: 'Site' },
  { word: 'check in', category: 'Site' },
  { word: 'streak', category: 'Site' },
  { word: 'overlay', category: 'Stream' },
  { word: 'channel points', category: 'Stream' },
  { word: 'punishment wheel', category: 'Site' },
  { word: 'donation goal', category: 'Stream' },
  { word: 'drummer', category: 'Stream' },
  { word: 'phantomace', category: 'Site' },
  { word: 'creature', category: 'Magic' },
  { word: 'instant', category: 'Magic' },
  { word: 'sorcery', category: 'Magic' },
  { word: 'enchantment', category: 'Magic' },
  { word: 'artifact', category: 'Magic' },
  { word: 'planeswalker', category: 'Magic' },
  { word: 'commander', category: 'Magic' },
  { word: 'battlefield', category: 'Magic' },
  { word: 'graveyard', category: 'Magic' },
  { word: 'library', category: 'Magic' },
  { word: 'sideboard', category: 'Magic' },
  { word: 'mulligan', category: 'Magic' },
  { word: 'counterspell', category: 'Magic' },
  { word: 'removal', category: 'Magic' },
  { word: 'board wipe', category: 'Magic' },
  { word: 'ramp', category: 'Magic' },
  { word: 'exile', category: 'Magic' },
  { word: 'scry', category: 'Magic' },
  { word: 'cascade', category: 'Magic' },
  { word: 'token', category: 'Magic' },
  { word: 'upkeep', category: 'Magic' },
  { word: 'combat', category: 'Magic' },
  { word: 'the stack', category: 'Magic' },
  { word: 'mana rock', category: 'Magic' },
  { word: 'fetchland', category: 'Magic' },
  { word: 'legendary', category: 'Magic' },
  { word: 'flying', category: 'Keyword' },
  { word: 'trample', category: 'Keyword' },
  { word: 'deathtouch', category: 'Keyword' },
  { word: 'lifelink', category: 'Keyword' },
  { word: 'vigilance', category: 'Keyword' },
  { word: 'haste', category: 'Keyword' },
  { word: 'hexproof', category: 'Keyword' },
  { word: 'menace', category: 'Keyword' },
  { word: 'first strike', category: 'Keyword' },
  { word: 'double strike', category: 'Keyword' },
  { word: 'indestructible', category: 'Keyword' },
  { word: 'ward', category: 'Keyword' },
  { word: 'flashback', category: 'Keyword' },
  { word: 'proliferate', category: 'Keyword' },
  { word: 'convoke', category: 'Keyword' },
  { word: 'affinity', category: 'Keyword' },
  { word: 'infect', category: 'Keyword' },
  { word: 'annihilator', category: 'Keyword' },
  { word: 'colorless', category: 'Magic' },
  { word: 'multicolor', category: 'Magic' },
  { word: 'aggro', category: 'Archetype' },
  { word: 'control', category: 'Archetype' },
  { word: 'midrange', category: 'Archetype' },
  { word: 'lifegain', category: 'Archetype' },
  { word: 'tribal', category: 'Archetype' },
  { word: 'voltron', category: 'Archetype' },
  { word: 'stax', category: 'Archetype' },
  { word: 'group hug', category: 'Archetype' },
  { word: 'booster', category: 'Format' },
  { word: 'draft', category: 'Format' },
  { word: 'sealed', category: 'Format' },
  { word: 'standard', category: 'Format' },
  { word: 'modern', category: 'Format' },
  { word: 'legacy', category: 'Format' },
  { word: 'vintage', category: 'Format' },
  { word: 'pauper', category: 'Format' },
  { word: 'planechase', category: 'Format' },
  { word: 'mythic', category: 'Rarity' },
  { word: 'uncommon', category: 'Rarity' },
  { word: 'broadcaster', category: 'Stream' },
  { word: 'moderator', category: 'Stream' },
  { word: 'subscriber', category: 'Stream' },
  { word: 'follower', category: 'Stream' },
  { word: 'lurker', category: 'Stream' },
  { word: 'emote', category: 'Stream' },
  { word: 'raid', category: 'Stream' },
  { word: 'clip', category: 'Stream' },
  { word: 'highlight', category: 'Stream' },
  { word: 'discord', category: 'Stream' },
  { word: 'mario', category: 'Nintendo' },
  { word: 'luigi', category: 'Nintendo' },
  { word: 'bowser', category: 'Nintendo' },
  { word: 'princess peach', category: 'Nintendo' },
  { word: 'yoshi', category: 'Nintendo' },
  { word: 'toad', category: 'Nintendo' },
  { word: 'wario', category: 'Nintendo' },
  { word: 'waluigi', category: 'Nintendo' },
  { word: 'donkey kong', category: 'Nintendo' },
  { word: 'diddy kong', category: 'Nintendo' },
  { word: 'kirby', category: 'Nintendo' },
  { word: 'meta knight', category: 'Nintendo' },
  { word: 'king dedede', category: 'Nintendo' },
  { word: 'samus aran', category: 'Nintendo' },
  { word: 'metroid', category: 'Nintendo' },
  { word: 'ridley', category: 'Nintendo' },
  { word: 'zelda', category: 'Nintendo' },
  { word: 'ganondorf', category: 'Nintendo' },
  { word: 'hyrule', category: 'Nintendo' },
  { word: 'triforce', category: 'Nintendo' },
  { word: 'master sword', category: 'Nintendo' },
  { word: 'ocarina', category: 'Nintendo' },
  { word: 'majora', category: 'Nintendo' },
  { word: 'korok', category: 'Nintendo' },
  { word: 'sheikah', category: 'Nintendo' },
  { word: 'rupee', category: 'Nintendo' },
  { word: 'goomba', category: 'Nintendo' },
  { word: 'koopa troopa', category: 'Nintendo' },
  { word: 'mushroom', category: 'Nintendo' },
  { word: 'fire flower', category: 'Nintendo' },
  { word: 'star fox', category: 'Nintendo' },
  { word: 'captain falcon', category: 'Nintendo' },
  { word: 'pikmin', category: 'Nintendo' },
  { word: 'splatoon', category: 'Nintendo' },
  { word: 'inkling', category: 'Nintendo' },
  { word: 'animal crossing', category: 'Nintendo' },
  { word: 'tom nook', category: 'Nintendo' },
  { word: 'villager', category: 'Nintendo' },
  { word: 'smash bros', category: 'Nintendo' },
  { word: 'mario kart', category: 'Nintendo' },
  { word: 'rainbow road', category: 'Nintendo' },
  { word: 'blue shell', category: 'Nintendo' },
  { word: 'warp pipe', category: 'Nintendo' },
  { word: 'amiibo', category: 'Nintendo' },
  { word: 'pikachu', category: 'Pokemon' },
  { word: 'charizard', category: 'Pokemon' },
  { word: 'bulbasaur', category: 'Pokemon' },
  { word: 'squirtle', category: 'Pokemon' },
  { word: 'charmander', category: 'Pokemon' },
  { word: 'eevee', category: 'Pokemon' },
  { word: 'snorlax', category: 'Pokemon' },
  { word: 'mewtwo', category: 'Pokemon' },
  { word: 'gengar', category: 'Pokemon' },
  { word: 'lucario', category: 'Pokemon' },
  { word: 'gyarados', category: 'Pokemon' },
  { word: 'magikarp', category: 'Pokemon' },
  { word: 'jigglypuff', category: 'Pokemon' },
  { word: 'psyduck', category: 'Pokemon' },
  { word: 'arcanine', category: 'Pokemon' },
  { word: 'dragonite', category: 'Pokemon' },
  { word: 'rayquaza', category: 'Pokemon' },
  { word: 'greninja', category: 'Pokemon' },
  { word: 'pokeball', category: 'Pokemon' },
  { word: 'pokedex', category: 'Pokemon' },
  { word: 'shiny', category: 'Pokemon' },
  { word: 'gym leader', category: 'Pokemon' },
  { word: 'team rocket', category: 'Pokemon' },
  { word: 'professor oak', category: 'Pokemon' },
  { word: 'evolution', category: 'Pokemon' },
  { word: 'legendary bird', category: 'Pokemon' },
  { word: 'sonic', category: 'Sega' },
  { word: 'tails', category: 'Sega' },
  { word: 'knuckles', category: 'Sega' },
  { word: 'doctor eggman', category: 'Sega' },
  { word: 'shadow', category: 'Sega' },
  { word: 'chaos emerald', category: 'Sega' },
  { word: 'green hill', category: 'Sega' },
  { word: 'dreamcast', category: 'Sega' },
  { word: 'mega drive', category: 'Sega' },
  { word: 'game gear', category: 'Sega' },
  { word: 'yakuza', category: 'Sega' },
  { word: 'persona', category: 'Sega' },
  { word: 'jet set radio', category: 'Sega' },
  { word: 'master chief', category: 'Halo' },
  { word: 'cortana', category: 'Halo' },
  { word: 'covenant', category: 'Halo' },
  { word: 'warthog', category: 'Halo' },
  { word: 'energy sword', category: 'Halo' },
  { word: 'cacodemon', category: 'Doom' },
  { word: 'cyberdemon', category: 'Doom' },
  { word: 'gordon freeman', category: 'Valve' },
  { word: 'crowbar', category: 'Valve' },
  { word: 'headcrab', category: 'Valve' },
  { word: 'black mesa', category: 'Valve' },
  { word: 'companion cube', category: 'Valve' },
  { word: 'glados', category: 'Valve' },
  { word: 'portal gun', category: 'Valve' },
  { word: 'turret', category: 'Valve' },
  { word: 'counter strike', category: 'Valve' },
  { word: 'team fortress', category: 'Valve' },
  { word: 'overwatch', category: 'Shooter' },
  { word: 'valorant', category: 'Shooter' },
  { word: 'call of duty', category: 'Shooter' },
  { word: 'battlefield ii', category: 'Shooter' },
  { word: 'rainbow six', category: 'Shooter' },
  { word: 'titanfall', category: 'Shooter' },
  { word: 'destiny', category: 'Shooter' },
  { word: 'borderlands', category: 'Shooter' },
  { word: 'bioshock', category: 'Shooter' },
  { word: 'big daddy', category: 'Shooter' },
  { word: 'rapture', category: 'Shooter' },
  { word: 'plasmid', category: 'Shooter' },
  { word: 'apex legends', category: 'Shooter' },
  { word: 'battle royale', category: 'Genre' },
  { word: 'fortnite', category: 'Shooter' },
  { word: 'final fantasy', category: 'RPG' },
  { word: 'chocobo', category: 'RPG' },
  { word: 'moogle', category: 'RPG' },
  { word: 'materia', category: 'RPG' },
  { word: 'cloud strife', category: 'RPG' },
  { word: 'sephiroth', category: 'RPG' },
  { word: 'aerith', category: 'RPG' },
  { word: 'tifa', category: 'RPG' },
  { word: 'summon', category: 'RPG' },
  { word: 'limit break', category: 'RPG' },
  { word: 'dragon quest', category: 'RPG' },
  { word: 'slime', category: 'RPG' },
  { word: 'chrono trigger', category: 'RPG' },
  { word: 'earthbound', category: 'RPG' },
  { word: 'undertale', category: 'RPG' },
  { word: 'sans', category: 'RPG' },
  { word: 'deltarune', category: 'RPG' },
  { word: 'skyrim', category: 'RPG' },
  { word: 'dragonborn', category: 'RPG' },
  { word: 'fus ro dah', category: 'RPG' },
  { word: 'whiterun', category: 'RPG' },
  { word: 'morrowind', category: 'RPG' },
  { word: 'oblivion', category: 'RPG' },
  { word: 'fallout', category: 'RPG' },
  { word: 'vault boy', category: 'RPG' },
  { word: 'nuka cola', category: 'RPG' },
  { word: 'pip boy', category: 'RPG' },
  { word: 'deathclaw', category: 'RPG' },
  { word: 'wasteland', category: 'RPG' },
  { word: 'the witcher', category: 'RPG' },
  { word: 'geralt', category: 'RPG' },
  { word: 'ciri', category: 'RPG' },
  { word: 'yennefer', category: 'RPG' },
  { word: 'gwent', category: 'RPG' },
  { word: 'mass effect', category: 'RPG' },
  { word: 'normandy', category: 'RPG' },
  { word: 'dragon age', category: 'RPG' },
  { word: 'baldurs gate', category: 'RPG' },
  { word: 'kingdom hearts', category: 'RPG' },
  { word: 'keyblade', category: 'RPG' },
  { word: 'xenoblade', category: 'RPG' },
  { word: 'octopath', category: 'RPG' },
  { word: 'disco elysium', category: 'RPG' },
  { word: 'dark souls', category: 'Soulslike' },
  { word: 'elden ring', category: 'Soulslike' },
  { word: 'bloodborne', category: 'Soulslike' },
  { word: 'sekiro', category: 'Soulslike' },
  { word: 'estus flask', category: 'Soulslike' },
  { word: 'bonfire', category: 'Soulslike' },
  { word: 'malenia', category: 'Soulslike' },
  { word: 'tarnished', category: 'Soulslike' },
  { word: 'lordran', category: 'Soulslike' },
  { word: 'praise the sun', category: 'Soulslike' },
  { word: 'hollow knight', category: 'Metroidvania' },
  { word: 'hornet', category: 'Metroidvania' },
  { word: 'hallownest', category: 'Metroidvania' },
  { word: 'castlevania', category: 'Metroidvania' },
  { word: 'alucard', category: 'Metroidvania' },
  { word: 'cuphead', category: 'Platformer' },
  { word: 'celeste', category: 'Platformer' },
  { word: 'super meat boy', category: 'Platformer' },
  { word: 'shovel knight', category: 'Platformer' },
  { word: 'hotline miami', category: 'Indie' },
  { word: 'minecraft', category: 'Sandbox' },
  { word: 'creeper', category: 'Sandbox' },
  { word: 'enderman', category: 'Sandbox' },
  { word: 'redstone', category: 'Sandbox' },
  { word: 'nether', category: 'Sandbox' },
  { word: 'diamond pickaxe', category: 'Sandbox' },
  { word: 'ender dragon', category: 'Sandbox' },
  { word: 'villager trade', category: 'Sandbox' },
  { word: 'terraria', category: 'Sandbox' },
  { word: 'stardew valley', category: 'Sandbox' },
  { word: 'junimo', category: 'Sandbox' },
  { word: 'pelican town', category: 'Sandbox' },
  { word: 'valheim', category: 'Survival' },
  { word: 'rust', category: 'Survival' },
  { word: 'the forest', category: 'Survival' },
  { word: 'subnautica', category: 'Survival' },
  { word: 'no mans sky', category: 'Survival' },
  { word: 'raft', category: 'Survival' },
  { word: 'grounded', category: 'Survival' },
  { word: 'dont starve', category: 'Survival' },
  { word: 'project zomboid', category: 'Survival' },
  { word: 'seven days', category: 'Survival' },
  { word: 'civilization', category: 'Strategy' },
  { word: 'starcraft', category: 'Strategy' },
  { word: 'age of empires', category: 'Strategy' },
  { word: 'warcraft', category: 'Strategy' },
  { word: 'total war', category: 'Strategy' },
  { word: 'xcom', category: 'Strategy' },
  { word: 'fire emblem', category: 'Strategy' },
  { word: 'advance wars', category: 'Strategy' },
  { word: 'command conquer', category: 'Strategy' },
  { word: 'the sims', category: 'Simulation' },
  { word: 'simcity', category: 'Simulation' },
  { word: 'cities skylines', category: 'Simulation' },
  { word: 'factorio', category: 'Simulation' },
  { word: 'rimworld', category: 'Simulation' },
  { word: 'dwarf fortress', category: 'Simulation' },
  { word: 'planet zoo', category: 'Simulation' },
  { word: 'theme park', category: 'Simulation' },
  { word: 'roller coaster', category: 'Simulation' },
  { word: 'farming sim', category: 'Simulation' },
  { word: 'flight sim', category: 'Simulation' },
  { word: 'euro truck', category: 'Simulation' },
  { word: 'resident evil', category: 'Horror' },
  { word: 'nemesis', category: 'Horror' },
  { word: 'umbrella', category: 'Horror' },
  { word: 'leon kennedy', category: 'Horror' },
  { word: 'silent hill', category: 'Horror' },
  { word: 'pyramid head', category: 'Horror' },
  { word: 'dead space', category: 'Horror' },
  { word: 'necromorph', category: 'Horror' },
  { word: 'amnesia', category: 'Horror' },
  { word: 'outlast', category: 'Horror' },
  { word: 'phasmophobia', category: 'Horror' },
  { word: 'dead by daylight', category: 'Horror' },
  { word: 'slender man', category: 'Horror' },
  { word: 'poppy playtime', category: 'Horror' },
  { word: 'street fighter', category: 'Fighting' },
  { word: 'chun li', category: 'Fighting' },
  { word: 'hadouken', category: 'Fighting' },
  { word: 'mortal kombat', category: 'Fighting' },
  { word: 'scorpion', category: 'Fighting' },
  { word: 'sub zero', category: 'Fighting' },
  { word: 'fatality', category: 'Fighting' },
  { word: 'tekken', category: 'Fighting' },
  { word: 'heihachi', category: 'Fighting' },
  { word: 'soul calibur', category: 'Fighting' },
  { word: 'guilty gear', category: 'Fighting' },
  { word: 'combo breaker', category: 'Fighting' },
  { word: 'frame data', category: 'Fighting' },
  { word: 'gran turismo', category: 'Racing' },
  { word: 'forza', category: 'Racing' },
  { word: 'need for speed', category: 'Racing' },
  { word: 'burnout', category: 'Racing' },
  { word: 'trackmania', category: 'Racing' },
  { word: 'rocket league', category: 'Sports' },
  { word: 'fifa', category: 'Sports' },
  { word: 'madden', category: 'Sports' },
  { word: 'tony hawk', category: 'Sports' },
  { word: 'league of legends', category: 'MOBA' },
  { word: 'summoners rift', category: 'MOBA' },
  { word: 'baron nashor', category: 'MOBA' },
  { word: 'teemo', category: 'MOBA' },
  { word: 'jungler', category: 'MOBA' },
  { word: 'last hit', category: 'MOBA' },
  { word: 'creep wave', category: 'MOBA' },
  { word: 'smite', category: 'MOBA' },
  { word: 'heroes storm', category: 'MOBA' },
  { word: 'world of warcraft', category: 'MMO' },
  { word: 'azeroth', category: 'MMO' },
  { word: 'horde', category: 'MMO' },
  { word: 'alliance', category: 'MMO' },
  { word: 'murloc', category: 'MMO' },
  { word: 'final fantasy xiv', category: 'MMO' },
  { word: 'runescape', category: 'MMO' },
  { word: 'old school', category: 'MMO' },
  { word: 'guild wars', category: 'MMO' },
  { word: 'everquest', category: 'MMO' },
  { word: 'raid boss', category: 'MMO' },
  { word: 'aggro table', category: 'MMO' },
  { word: 'healer', category: 'MMO' },
  { word: 'tank role', category: 'MMO' },
  { word: 'hades', category: 'Roguelike' },
  { word: 'zagreus', category: 'Roguelike' },
  { word: 'slay the spire', category: 'Roguelike' },
  { word: 'binding isaac', category: 'Roguelike' },
  { word: 'risk of rain', category: 'Roguelike' },
  { word: 'dead cells', category: 'Roguelike' },
  { word: 'enter gungeon', category: 'Roguelike' },
  { word: 'spelunky', category: 'Roguelike' },
  { word: 'noita', category: 'Roguelike' },
  { word: 'balatro', category: 'Roguelike' },
  { word: 'vampire survivor', category: 'Roguelike' },
  { word: 'among us', category: 'Indie' },
  { word: 'fall guys', category: 'Indie' },
  { word: 'untitled goose', category: 'Indie' },
  { word: 'papers please', category: 'Indie' },
  { word: 'braid', category: 'Indie' },
  { word: 'limbo', category: 'Indie' },
  { word: 'inside', category: 'Indie' },
  { word: 'journey', category: 'Indie' },
  { word: 'firewatch', category: 'Indie' },
  { word: 'outer wilds', category: 'Indie' },
  { word: 'rain world', category: 'Indie' },
  { word: 'tunic', category: 'Indie' },
  { word: 'stray', category: 'Indie' },
  { word: 'pac man', category: 'Arcade' },
  { word: 'space invaders', category: 'Arcade' },
  { word: 'galaga', category: 'Arcade' },
  { word: 'centipede', category: 'Arcade' },
  { word: 'asteroids', category: 'Arcade' },
  { word: 'frogger', category: 'Arcade' },
  { word: 'dig dug', category: 'Arcade' },
  { word: 'tetris', category: 'Arcade' },
  { word: 'tetromino', category: 'Arcade' },
  { word: 'pinball', category: 'Arcade' },
  { word: 'high score', category: 'Arcade' },
  { word: 'pong', category: 'Arcade' },
  { word: 'street brawl', category: 'Arcade' },
  { word: 'playstation', category: 'Hardware' },
  { word: 'nintendo', category: 'Hardware' },
  { word: 'xbox', category: 'Hardware' },
  { word: 'gamecube', category: 'Hardware' },
  { word: 'game boy', category: 'Hardware' },
  { word: 'nintendo ds', category: 'Hardware' },
  { word: 'switch', category: 'Hardware' },
  { word: 'steam deck', category: 'Hardware' },
  { word: 'cartridge', category: 'Hardware' },
  { word: 'joystick', category: 'Hardware' },
  { word: 'gamepad', category: 'Hardware' },
  { word: 'controller', category: 'Hardware' },
  { word: 'emulator', category: 'Hardware' },
  { word: 'rumble pak', category: 'Hardware' },
  { word: 'memory card', category: 'Hardware' },
  { word: 'arcade stick', category: 'Hardware' },
  { word: 'light gun', category: 'Hardware' },
  { word: 'virtual boy', category: 'Hardware' },
  { word: 'atari', category: 'Hardware' },
  { word: 'respawn', category: 'Gaming' },
  { word: 'checkpoint', category: 'Gaming' },
  { word: 'cutscene', category: 'Gaming' },
  { word: 'hitbox', category: 'Gaming' },
  { word: 'cooldown', category: 'Gaming' },
  { word: 'loadout', category: 'Gaming' },
  { word: 'crafting', category: 'Gaming' },
  { word: 'grinding', category: 'Gaming' },
  { word: 'farming', category: 'Gaming' },
  { word: 'matchmaking', category: 'Gaming' },
  { word: 'achievement', category: 'Gaming' },
  { word: 'trophy', category: 'Gaming' },
  { word: 'speedrun', category: 'Gaming' },
  { word: 'glitch', category: 'Gaming' },
  { word: 'exploit', category: 'Gaming' },
  { word: 'patch notes', category: 'Gaming' },
  { word: 'expansion', category: 'Gaming' },
  { word: 'open world', category: 'Gaming' },
  { word: 'side quest', category: 'Gaming' },
  { word: 'main quest', category: 'Gaming' },
  { word: 'skill tree', category: 'Gaming' },
  { word: 'hit points', category: 'Gaming' },
  { word: 'mana bar', category: 'Gaming' },
  { word: 'boss fight', category: 'Gaming' },
  { word: 'final boss', category: 'Gaming' },
  { word: 'mini boss', category: 'Gaming' },
  { word: 'easter egg', category: 'Gaming' },
  { word: 'new game plus', category: 'Gaming' },
  { word: 'permadeath', category: 'Gaming' },
  { word: 'sandbox mode', category: 'Gaming' },
  { word: 'split screen', category: 'Gaming' },
  { word: 'couch coop', category: 'Gaming' },
  { word: 'friendly fire', category: 'Gaming' },
  { word: 'spawn camp', category: 'Gaming' },
  { word: 'quick save', category: 'Gaming' },
  { word: 'auto save', category: 'Gaming' },
  { word: 'fast travel', category: 'Gaming' },
  { word: 'loot box', category: 'Gaming' },
  { word: 'battle pass', category: 'Gaming' },
  { word: 'season pass', category: 'Gaming' },
  { word: 'early access', category: 'Gaming' },
  { word: 'day one patch', category: 'Gaming' },
  { word: 'frame rate', category: 'Gaming' },
  { word: 'render distance', category: 'Gaming' },
  { word: 'ray tracing', category: 'Gaming' },
  { word: 'pixel art', category: 'Gaming' },
  { word: 'sprite sheet', category: 'Gaming' },
  { word: 'game jam', category: 'Gaming' },
  { word: 'playtester', category: 'Gaming' },
  { word: 'speedrunner', category: 'Gaming' },
  { word: 'no hit run', category: 'Gaming' },
  { word: 'any percent', category: 'Gaming' },
  { word: 'world record', category: 'Gaming' },
  { word: 'frame perfect', category: 'Gaming' },
  { word: 'tool assisted', category: 'Gaming' },
  { word: 'softlock', category: 'Gaming' },
  { word: 'rage quit', category: 'Gaming' },
  { word: 'camping', category: 'Gaming' },
  { word: 'griefing', category: 'Gaming' },
  { word: 'smurfing', category: 'Gaming' },
  { word: 'twitch reflex', category: 'Gaming' },
  { word: 'button mash', category: 'Gaming' },
  { word: 'quick time', category: 'Gaming' },
  { word: 'platformer', category: 'Genre' },
  { word: 'roguelike', category: 'Genre' },
  { word: 'metroidvania', category: 'Genre' },
  { word: 'soulslike', category: 'Genre' },
  { word: 'bullet hell', category: 'Genre' },
  { word: 'tower defense', category: 'Genre' },
  { word: 'rhythm game', category: 'Genre' },
  { word: 'visual novel', category: 'Genre' },
  { word: 'point and click', category: 'Genre' },
  { word: 'beat em up', category: 'Genre' },
  { word: 'hack and slash', category: 'Genre' },
  { word: 'deck builder', category: 'Genre' },
  { word: 'idle clicker', category: 'Genre' },
  { word: 'walking sim', category: 'Genre' },
  { word: 'immersive sim', category: 'Genre' },
  { word: 'survival horror', category: 'Genre' },
  { word: 'dungeon crawl', category: 'Genre' },
  { word: 'sandbox', category: 'Genre' },
  { word: 'stealth game', category: 'Genre' },
  { word: 'party game', category: 'Genre' },
  { word: 'rockstar', category: 'Studio' },
  { word: 'ubisoft', category: 'Studio' },
  { word: 'bethesda', category: 'Studio' },
  { word: 'bioware', category: 'Studio' },
  { word: 'capcom', category: 'Studio' },
  { word: 'konami', category: 'Studio' },
  { word: 'square enix', category: 'Studio' },
  { word: 'bandai namco', category: 'Studio' },
  { word: 'from software', category: 'Studio' },
  { word: 'naughty dog', category: 'Studio' },
  { word: 'insomniac', category: 'Studio' },
  { word: 'santa monica', category: 'Studio' },
  { word: 'obsidian', category: 'Studio' },
  { word: 'larian', category: 'Studio' },
  { word: 'supergiant', category: 'Studio' },
  { word: 'team cherry', category: 'Studio' },
  { word: 'grand theft auto', category: 'Game' },
  { word: 'red dead', category: 'Game' },
  { word: 'assassins creed', category: 'Game' },
  { word: 'far cry', category: 'Game' },
  { word: 'watch dogs', category: 'Game' },
  { word: 'splinter cell', category: 'Game' },
  { word: 'metal gear', category: 'Game' },
  { word: 'solid snake', category: 'Game' },
  { word: 'cardboard box', category: 'Game' },
  { word: 'god of war', category: 'Game' },
  { word: 'kratos', category: 'Game' },
  { word: 'leviathan axe', category: 'Game' },
  { word: 'uncharted', category: 'Game' },
  { word: 'nathan drake', category: 'Game' },
  { word: 'last of us', category: 'Game' },
  { word: 'ellie', category: 'Game' },
  { word: 'clicker', category: 'Game' },
  { word: 'horizon', category: 'Game' },
  { word: 'aloy', category: 'Game' },
  { word: 'spider man', category: 'Game' },
  { word: 'ratchet clank', category: 'Game' },
  { word: 'crash bandicoot', category: 'Game' },
  { word: 'spyro', category: 'Game' },
  { word: 'tomb raider', category: 'Game' },
  { word: 'lara croft', category: 'Game' },
  { word: 'prince persia', category: 'Game' },
  { word: 'dead cells run', category: 'Game' },
  { word: 'cyberpunk', category: 'Game' },
  { word: 'night city', category: 'Game' },
  { word: 'johnny silver', category: 'Game' },
  { word: 'death stranding', category: 'Game' },
  { word: 'alan wake', category: 'Game' },
  { word: 'max payne', category: 'Game' },
  { word: 'bully', category: 'Game' },
  { word: 'sleeping dogs', category: 'Game' },
  { word: 'just cause', category: 'Game' },
  { word: 'saints row', category: 'Game' },
  { word: 'mafia', category: 'Game' },
  { word: 'hitman', category: 'Game' },
  { word: 'agent forty seven', category: 'Game' },
  { word: 'dishonored', category: 'Game' },
  { word: 'prey', category: 'Game' },
  { word: 'deus ex', category: 'Game' },
  { word: 'system shock', category: 'Game' },
  { word: 'star citizen', category: 'Game' },
  { word: 'elite dangerous', category: 'Game' },
  { word: 'kerbal', category: 'Game' },
  { word: 'astroneer', category: 'Game' },
  { word: 'satisfactory', category: 'Game' },
  { word: 'oxygen not', category: 'Game' },
  { word: 'slime rancher', category: 'Game' },
  { word: 'powerwash sim', category: 'Game' },
  { word: 'lethal company', category: 'Game' },
  { word: 'content warning', category: 'Game' },
  { word: 'repo', category: 'Game' },
  { word: 'helldivers', category: 'Game' },
  { word: 'deep rock', category: 'Game' },
  { word: 'rock and stone', category: 'Game' },
  { word: 'warframe', category: 'Game' },
  { word: 'path of exile', category: 'Game' },
  { word: 'diablo', category: 'Game' },
  { word: 'torchlight', category: 'Game' },
  { word: 'grim dawn', category: 'Game' },
  { word: 'last epoch', category: 'Game' },
  { word: 'monster hunter', category: 'Game' },
  { word: 'palworld', category: 'Game' },
  { word: 'temtem', category: 'Game' },
  { word: 'cassette beasts', category: 'Game' },
  { word: 'the isle', category: 'Game' },
  { word: 'path of titans', category: 'Game' },
  { word: 'beasts of bermuda', category: 'Game' },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* ══ The rules, as pure functions ═══════════════════════════════════════ */

/**
 * Compare a chat message to the answer.
 *
 * Deliberately forgiving: case, spacing and punctuation are all discarded,
 * so "Mana Clash", "manaclash" and "mana-clash!" all count. Being strict
 * here produces the worst possible experience — a viewer who plainly knew
 * the answer being told nothing happened.
 */
export function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function isCorrect(guess, word) {
  const g = normalise(guess);
  return g.length > 0 && g === normalise(word);
}

/**
 * Scramble each word of the phrase, keeping the word breaks.
 *
 * Breaks are kept because they carry the shape of the answer — "mana clash"
 * scrambled into one run of nine letters is a different, much harder game
 * than two runs of four and five, and the hint is calibrated for the easier
 * one.
 *
 * A letter arrangement identical to the original is re-rolled: a "scramble"
 * that shows the answer is the one outcome that makes the round pointless.
 * Short words can be unshufflable (a single letter, or a repeated pair), so
 * the attempt count is bounded and the caller must tolerate a word coming
 * back as itself rather than looping forever.
 */
export function scramble(phrase, rng = Math.random) {
  return String(phrase).split(' ').map((part) => {
    if (part.length < 2) return part;
    for (let attempt = 0; attempt < 12; attempt++) {
      const letters = part.split('');
      for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
      }
      const out = letters.join('');
      if (out !== part) return out;
    }
    return part;
  }).join(' ');
}

/** Everything the overlay is allowed to know. The answer is not in it. */
export function publicState(game, now = Date.now()) {
  if (!game || game.status === 'idle') {
    return { status: 'idle', round: 0, scores: [] };
  }

  const scores = Object.entries(game.scores || {})
    .map(([id, s]) => ({ id, name: s.name, points: s.points }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, 5);

  const base = {
    status: game.status,
    round: game.round,
    category: game.category,
    display: game.display,
    answered: (game.answered || []).length,
    scores,
    serverNow: now,
  };

  if (game.status === 'running') {
    return { ...base, msLeft: Math.max(0, game.endsAt - now) };
  }

  /* Only once the round is over does the answer go out. */
  return {
    ...base,
    word: game.word,
    winner: game.winner,
    msLeft: Math.max(0, game.revealUntil - now),
  };
}

/* ══ Lifecycle ══════════════════════════════════════════════════════════ */

function pickWord(recent) {
  const avoid = new Set(recent || []);
  const pool = WORDS.filter(w => !avoid.has(w.word));
  const from = pool.length ? pool : WORDS;
  return from[Math.floor(Math.random() * from.length)];
}

function startRound(game, now) {
  const picked = pickWord(game.recent);
  game.status = 'running';
  game.round = (game.round || 0) + 1;
  game.word = picked.word;
  game.category = picked.category;
  game.display = scramble(picked.word).toUpperCase();
  game.startedAt = now;
  game.endsAt = now + ROUND_MS;
  game.revealUntil = null;
  game.answered = [];
  game.winner = null;
  /* Enough history that a word does not come round twice in a break. */
  game.recent = [picked.word, ...(game.recent || [])].slice(0, 10);
  return game;
}

function endRound(game, now) {
  game.status = 'reveal';
  game.revealUntil = now + REVEAL_MS;
  return game;
}

/**
 * Apply whatever the clock owes — a round that has run out, a reveal that
 * has finished. Lazy, on whatever request arrives next, exactly as the
 * rooms in Mana Clash do: a scheduler would tie game state to the lifetime
 * of the process.
 *
 * Returns { changed, closed, opened }. `closed` is a round that ran out of
 * time; `opened` is a round that started on its own.
 *
 * `opened` exists because the overlay is OPTIONAL. The bot posts each
 * scramble to chat, so the game is playable with no overlay at all — but a
 * round that auto-advanced used to announce nothing, so only round one ever
 * reached chat and every round after it opened in silence. With an overlay
 * that merely meant no nudge; without one the game simply stopped after the
 * first round.
 *
 * The transition happens inside the caller's lock, so exactly one caller
 * ever sees `opened` for a given round and it cannot be announced twice.
 */
export function advance(game, now = Date.now()) {
  let changed = false;
  let closed = null;
  let opened = null;

  if (game.status === 'running' && now >= game.endsAt) {
    endRound(game, now);
    closed = { word: game.word, round: game.round };
    changed = true;
  }

  if (game.status === 'reveal' && now >= game.revealUntil) {
    if (game.autoContinue) {
      startRound(game, now);
      opened = { category: game.category, display: game.display, round: game.round };
    } else {
      game.status = 'idle';
    }
    changed = true;
  }

  return { changed, closed, opened };
}

function freshGame() {
  return {
    status: 'idle', round: 0, word: null, category: null, display: null,
    startedAt: null, endsAt: null, revealUntil: null,
    answered: [], winner: null, scores: {}, recent: [], autoContinue: true,
  };
}

/* ── The chat scramble ───────────────────────────────────────────────────
   Announcements only, never a reply to a guess. The bot is capped at
   roughly twenty messages per thirty seconds as a non-moderator, so a line
   per guess would silence it within seconds of a busy round — and a
   throttled message comes back as HTTP 200 with is_sent false, so it would
   fail without saying so. Live state goes on the overlay instead. */
export async function announceGame(env, announce) {
  if (!announce) return;
  const { sendChatMessage } = await import('./bot/send-chat.js');

  if (announce.kind === 'start') {
    /* The category goes in the chat line too, not only on the overlay —
       the overlay is optional, and without the clue a chat-only round is
       a wall of letters with no way in. */
    await sendChatMessage(env, `[${announce.category}] Unscramble: ${announce.display} — type your answer in chat!`);
  } else if (announce.kind === 'win') {
    await sendChatMessage(env, `@${announce.name} got it — ${announce.word.toUpperCase()}! +2 giveaway entries.`);
  } else if (announce.kind === 'timeout') {
    await sendChatMessage(env, `Time! It was ${announce.word.toUpperCase()}. Next one coming up.`);
  } else if (announce.kind === 'skip') {
    await sendChatMessage(env, `Skipped — it was ${announce.word.toUpperCase()}.`);
  } else if (announce.kind === 'stop') {
    const top = Object.values(announce.scores || {})
      .sort((a, b) => b.points - a.points).slice(0, 3)
      .map((s, i) => `${i + 1}. ${s.name} (${s.points})`).join('  ');
    await sendChatMessage(env, top ? `Scramble over! ${top}` : 'Scramble over!');
  }
}

/* ══ Called from the chat webhook ═══════════════════════════════════════ */

/**
 * Offer a chat message to the running round.
 *
 * Returns what the caller should announce, or null for the overwhelmingly
 * common case of a message that is not the answer. The bot says nothing for
 * a wrong guess — that is the rate limit rule, and also the right feel: a
 * wrong guess should cost nothing and go unremarked.
 */
export async function offerGuess(env, { userId, name, text }) {
  if (!userId) return null;

  const announce = [];
  let credited = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    const game = current && current.status ? current : freshGame();
    const now = Date.now();
    const { changed, closed, opened } = advance(game, now);
    if (closed) announce.push({ kind: 'timeout', word: closed.word });
    if (opened) announce.push({ kind: 'start', category: opened.category, display: opened.display });

    if (game.status !== 'running') return changed ? game : undefined;

    const id = String(userId);
    const known = game.answered.includes(id);
    if (!known) game.answered.push(id);

    if (!isCorrect(text, game.word)) {
      /* A wrong guess writes only if it told us something — a chatter we had
         not counted yet, or a clock that moved. Otherwise every message in a
         busy chat would take the row's lock to store what it already said,
         and chat during a break is exactly when volume is highest. */
      return (!known || changed) ? game : undefined;
    }

    /* The claim happens INSIDE the lock. Many people type the answer within
       the same second — that is what a right answer looks like — and
       checking "is there a winner yet" outside the lock would credit
       several of them. */
    if (game.winner) return game;

    game.winner = { userId: id, name, at: now };
    const prev = game.scores[id] || { name, points: 0 };
    game.scores[id] = { name, points: prev.points + 1 };

    /* Keep the scoreboard from growing without bound over a long break. */
    const entries = Object.entries(game.scores);
    if (entries.length > MAX_SCORES) {
      entries.sort((a, b) => b[1].points - a[1].points);
      game.scores = Object.fromEntries(entries.slice(0, MAX_SCORES));
    }

    endRound(game, now);
    announce.push({ kind: 'win', word: game.word, name, points: game.scores[id].points });
    credited = { id, name };
    return game;
  });

  /* Entries are credited outside the lock — it is another key, and holding
     one row's lock while writing another invites a deadlock the moment a
     second feature does the same thing in the other order. */
  if (credited) {
    try {
      const { addEntries } = await import('./giveaway-entries.js');
      await addEntries(env, credited.id, credited.name, WIN_ENTRIES, 'chat-scramble');
    } catch (err) {
      /* The win still stands. Losing the entries is worth a log, not a
         reversal of something already announced in chat. */
      console.error('[chat-scramble] entry credit failed:', err.message);
    }
  }

  return announce.length ? announce : null;
}

/**
 * Move the clock without a guess, and report anything chat should be told.
 *
 * Called from the state poll, so the game keeps running while nobody is
 * typing — which is most of a round. Without it the clock would only ever
 * advance when somebody spoke, and a round with no chatter would hang until
 * one did.
 */
export async function tickGame(env) {
  const announce = [];
  let game = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    game = current && current.status ? current : freshGame();
    const { changed, closed, opened } = advance(game, Date.now());
    if (closed) announce.push({ kind: 'timeout', word: closed.word });
    if (opened) announce.push({ kind: 'start', category: opened.category, display: opened.display });
    return changed ? game : undefined;
  });

  return { game, announce };
}

/* ══ Routes ═════════════════════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env } = context;

  /* The poll is what moves the clock. The overlay polls once a second while
     a game runs, so rounds close on time without anything scheduled. */
  const { game, announce } = await tickGame(env);

  /* The poll is also what tells chat a new round has opened, because the
     overlay is optional and the bot's message is the only prompt a
     chat-only game gets. Exactly one caller sees each transition — it
     happens under the row's lock — so this cannot double-post. */
  if (announce.length) {
    try {
      for (const a of announce) await announceGame(env, a);
    } catch (err) {
      console.error('[chat-scramble] announce failed:', err.message);
    }
  }

  return json(publicState(game));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run the chat game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const result = await controlGame(env, body.action, body);
  if (result.error) return json({ error: result.error }, 400);
  return json(result);
}

/** Shared by the route and the !scramble chat command. */
export async function controlGame(env, action, opts = {}) {
  let announce = null;
  let state = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    const game = current && current.status ? current : freshGame();
    const now = Date.now();

    if (action === 'start') {
      /* Starting fresh resets the scoreboard: a break is a session, and
         carrying scores across two separate BRBs hours apart reads as a bug
         rather than continuity. */
      const restart = opts.keepScores ? game.scores : {};
      Object.assign(game, freshGame(), { scores: restart, recent: game.recent || [] });
      game.autoContinue = opts.autoContinue !== false;
      startRound(game, now);
      announce = { kind: 'start', category: game.category, display: game.display };
    } else if (action === 'skip') {
      if (game.status === 'idle') return undefined;
      announce = { kind: 'skip', word: game.word };
      startRound(game, now);
    } else if (action === 'stop') {
      if (game.status === 'idle') return undefined;
      announce = { kind: 'stop', scores: game.scores };
      Object.assign(game, freshGame(), { recent: game.recent, scores: game.scores });
    } else {
      return undefined;
    }

    state = game;
    return game;
  });

  if (!state) return { error: 'Nothing to do — no game is running.' };
  return { success: true, announce, state: publicState(state) };
}
