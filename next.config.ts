import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js prints every Server Action call with its arguments: sendVote() receives the whole proof
  // (about 300 000 characters), which floods the terminal. Our own console.log lines show what matters.
  logging: {
    serverFunctions: false,
  },
  experimental: {
    optimizePackageImports: ["@chakra-ui/react"],
  },
};

export default nextConfig;
