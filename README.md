# Artifacts MMO Bot

Personal TypeScript bot for managing my 5-character crew in Artifacts MMO.

**Characters:**
- **Stan** — Main character, primary farmer
- **Kyle** — Combat specialist, raid participant  
- **Cartman** — Crafter, resource manager
- **Kenny** — Scout, exploration & task runner
- **Butters** — Support, banking & item distribution

## Status

🚧 **In Development** — Currently building out core functionality

### Planned Features

- [ ] Automated farming loop for Stan & Kyle
- [ ] Crafting pipeline (Cartman resource management)
- [ ] Grand Exchange trading bot
- [ ] Bank synchronization across all characters
- [ ] Task automation & reward collection
- [ ] Combat automation for raids
- [ ] Discord notifications for important events
- [ ] Web dashboard for monitoring

## Tech Stack

- **Runtime:** Node.js 18+
- **Language:** TypeScript
- **API:** Artifacts MMO v8.0.1
- **Package Manager:** npm

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Artifacts token

# Run the bot
npm run dev
```

## Project Structure

```
.
├── src/
│   ├── bot/              # Main bot logic
│   │   ├── characters/   # Per-character strategies
│   │   │   ├── stan.ts
│   │   │   ├── kyle.ts
│   │   │   ├── cartman.ts
│   │   │   ├── kenny.ts
│   │   │   └── butters.ts
│   │   ├── strategies/   # Farming, trading, crafting logic
│   │   └── tasks/        # One-off operations
│   ├── client/           # Artifacts MMO API wrapper
│   ├── utils/            # Helpers, logging, types
│   └── index.ts          # Entry point
├── tests/
├── .env.example
└── package.json
```

## Configuration

### Environment Variables

```bash
# .env
ARTIFACTS_TOKEN=your_jwt_token_here
LOG_LEVEL=info
NODE_ENV=development

# Optional
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ENABLE_NOTIFICATIONS=true
```

## Current Implementation

### Active Features

#### Stan — Farming
```typescript
// Automated resource gathering loop
- Gathers on available resources
- Returns to bank when inventory full
- Logs all activities
```

#### Characters State Tracking
```typescript
// Check character status anytime
npm run status

// Output:
// Stan:     Level 42, HP: 150/150, Location: forest
// Kyle:     Level 38, HP: 120/150, Location: dungeon
// Cartman:  Level 35, HP: 100/100, Location: workshop
// Kenny:    Level 40, HP: 140/150, Location: bank
// Butters:  Level 36, HP: 110/120, Location: market
```

#### Bank Operations
```typescript
// Deposit resources to Butters (central bank)
npm run bank:deposit

// Withdraw crafting materials
npm run bank:withdraw cartman materials
```

## Scripts

```bash
# Development
npm run dev          # Run bot with hot reload
npm run build        # Compile TypeScript
npm run type-check   # Type checking only

# Utilities
npm run status       # Get all characters status
npm run inventory    # List all inventories
npm run logs         # View bot logs

# Operations
npm run farm:stan    # Start Stan's farming loop
npm run bank:sync    # Sync bank across all characters
npm run fight:kyle   # Start Kyle's combat
```

## Known Issues & Limitations

- ⚠️ Rate limiting not yet implemented (need to handle Artifacts API cooldowns)
- ⚠️ Error recovery needs improvement (some crashes on network issues)
- ⚠️ No persistence layer yet (state resets on restart)
- ⚠️ No database integration (can't track long-term statistics)

## Next Steps

1. **Phase 1** — Core stability
   - [ ] Robust error handling
   - [ ] State persistence (SQLite or JSON)
   - [ ] Rate limit management

2. **Phase 2** — Intelligence
   - [ ] Smart farming routes
   - [ ] Crafting pipeline optimization
   - [ ] Trading strategies

3. **Phase 3** — Automation
   - [ ] Full hands-off operation
   - [ ] Discord integration
   - [ ] Web dashboard

4. **Phase 4** — Polish
   - [ ] Metrics & analytics
   - [ ] Configuration UI
   - [ ] Community features (leaderboards, etc)

## Debugging

### Enable Verbose Logging
```bash
LOG_LEVEL=debug npm run dev
```

### Check Character State
```bash
npm run status

# or programmatically:
import { bot } from './src';
const char = await bot.getCharacter('Stan');
console.log(char);
```

### View Recent Logs
```bash
tail -f logs/bot.log
```

## Testing

```bash
npm test              # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

## Resources

- 📖 [Artifacts MMO Docs](https://docs.artifactsmmo.com/)
- 🔗 [OpenAPI Spec](https://api.artifactsmmo.com/openapi.json)
- 🎮 [Game Website](https://artifactsmmo.com/)

## Notes

- This is a **personal project** for learning TypeScript, async patterns, and API automation
- Not affiliated with Artifacts MMO team
- Please respect the game's ToS when using automation
- Ban risk is assumed by the user

## Changelog

### v0.0.1 (Current)
- ✅ Basic character state tracking
- ✅ API client wrapper
- ✅ Stan's farming loop (WIP)
- ✅ Bank deposit/withdraw

---

**Last Updated:** 2024
**Next Sprint:** Implement rate limiting & state persistence
