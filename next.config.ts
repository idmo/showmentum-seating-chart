import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone — a self-contained server bundle with only
  // the node_modules it actually traces as used, so the Docker image
  // doesn't need a full `npm install` at runtime.
  output: "standalone",
  experimental: {
    serverActions: {
      // Guest-list CSVs can be a few thousand rows — bump past the 1MB
      // default so a large event's uploadGuestList action isn't rejected.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
