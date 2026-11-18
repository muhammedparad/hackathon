import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "RoomTrace — See the room, without cameras" },
      {
        name: "description",
        content:
          "Camera-free room awareness with mmWave radar: occupancy, movement and live floor plans.",
      },
      { property: "og:title", content: "RoomTrace — See the room, without cameras" },
      {
        property: "og:description",
        content:
          "Camera-free room awareness with mmWave radar: occupancy, movement and live floor plans.",
      },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/overview" });
  },
});
