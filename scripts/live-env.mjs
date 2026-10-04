// Preloaded by `pnpm start` (node --import): the built board started that way is the live board, so it
// runs as production whatever BOARD_ENV the shell or .env has, and production always asks the gate
// (AUTH=off is refused at startup). To run a build without the gate, see README "Test mode".
process.env.BOARD_ENV = 'production'
