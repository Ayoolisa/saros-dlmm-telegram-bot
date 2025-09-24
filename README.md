# Saros DLMM Telegram Bot

A Telegram bot for managing liquidity positions on Saros DLMM on Solana devnet. Built for the Saros Hackathon.

## Features
- View positions (`/positions`): Displays formatted liquidity positions.
- Add liquidity (`/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`).
- Remove liquidity (`/remove_liquidity <position_pubkey> <amount>`).
- Rebalance (`/rebalance`): Suggests bin adjustments.
- Pool stats (`/stats`): Mock analytics.
- Interactive buttons for navigation.

## Setup
1. Clone: `git clone <your-repo-url>`
2. Install: `npm install`
3. Create `.env`:
