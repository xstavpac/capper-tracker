/** @type {import('next').NextConfig} */
const nextConfig = {
  // League logos for the Slate Bar: ESPN's own league logo files.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "a.espncdn.com", pathname: "/i/teamlogos/leagues/**" },
      { protocol: "https", hostname: "a.espncdn.com", pathname: "/redesign/assets/img/icons/**" },
    ],
  },
  experimental: {
    staleTimes: { dynamic: 0 },
  },
};

export default nextConfig;
