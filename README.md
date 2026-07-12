# Artifacts MMO Bot

Personal TypeScript bot for managing my 5-character crew in Artifacts MMO.

**Characters:**

- **Cartman** — Main character, primary farmer & general automation
- **Stan** — Crafter, resource management & item optimization
- **Kyle** — Combat specialist, raid participant
- **Kenny** — Scout, exploration & task runner
- **Butters** — Support, banking & item distribution

## Status

🚧 **In Development** — Currently building out core functionality

### Planned Features

- [ ] Automated farming loop for Cartman & Kyle
- [ ] Crafting pipeline (Stan resource management)
- [ ] Grand Exchange trading bot
- [ ] Bank synchronization across all characters
- [ ] Task automation & reward collection
- [ ] Combat automation for raids
- [ ] Discord notifications for important events
- [ ] Web dashboard for monitoring

## Tech Stack

- **Runtime:** Node.js 24.17.0
- **Language:** TypeScript
- **API:** Artifacts MMO v8.0.1
- **Package Manager:** pnpm 11.9.0 (enforced via `packageManager`/`devEngines` in `package.json`)
- **Validation:** Zod
- **Dates:** date-fns (Temporal isn't natively available yet on Node 24 without `--experimental-temporal` or a polyfill)
- **Testing:** Vitest
- **Linting/Formatting:** oxlint + oxfmt

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your Artifacts token

# Run the bot
pnpm dev
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

#### Cartman — Farming

```typescript
// Automated resource gathering loop
- Gathers on available resources
- Returns to bank when inventory full
- Logs all activities
```

#### Stan — Crafting Pipeline

```typescript
// Resource-to-item automation
- Pulls materials from bank (Butters)
- Crafts at available workshops
- Optimizes crafting order based on XP/profit
- Deposits finished items back to bank
```

#### Characters State Tracking

```typescript
// Check character status anytime
pnpm status

// Output:
// Cartman:  Level 42, HP: 150/150, Location: forest (farming)
// Stan:     Level 38, HP: 120/150, Location: workshop (crafting)
// Kyle:     Level 40, HP: 140/150, Location: dungeon (combat)
// Kenny:    Level 36, HP: 110/120, Location: bank (tasks)
// Butters:  Level 35, HP: 100/100, Location: bank (central hub)
```

#### Bank Operations

```typescript
// Deposit resources to Butters (central bank)
pnpm bank:deposit

// Withdraw crafting materials for Stan
pnpm bank:withdraw stan materials
```

## Scripts

```bash
# Development
pnpm dev          # Run bot with hot reload
pnpm build        # Compile TypeScript
pnpm type-check   # Type checking only

# Utilities
pnpm status       # Get all characters status
pnpm inventory    # List all inventories
pnpm logs         # View bot logs

# Operations
pnpm farm:cartman   # Start Cartman's farming loop
pnpm craft:stan     # Start Stan's crafting pipeline
pnpm bank:sync      # Sync bank across all characters
pnpm fight:kyle     # Start Kyle's combat
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
LOG_LEVEL=debug pnpm dev
```

### Check Character State

```bash
pnpm status

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
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
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
