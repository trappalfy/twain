import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "twain",
    short_name: "twain",
    description: "Launch a coin paired with any asset, from memes to tokenized stocks.",
    start_url: "/",
    display: "standalone",
    background_color: "#EEF6FF",
    theme_color: "#EEF6FF",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
