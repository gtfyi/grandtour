---
locale: en
name: English
dir: ltr
meta:
  title: GrandTour
  description: >-
    GrandTour provides location-triggered audio narration on your phone.
# The track the landing page's phone frame drives as a simulated trip, by
# slug. It must be in the published content the site is built with; otherwise
# the frame shows the app with no trip to drive.
demo_track: going-to-the-sun-road-audio-tour
strings:
  nav.app: Fullscreen
  nav.source: Source
  footer.copyright: © 2026 GrandTour
---

## hero

# Grand Tour: Local Audio

Grand Tour is a free, open-source app for place-tied audio. You can use it to listen to audio tours, and much more:

- Record your own tours or local memories, for family, friends or the public
- Have AI generate tours for you, on any topic you like
- Use it to study, tying places to topics in a memory palace
- Make an audio scavenger hunt
- Learn about local shops, restaurants, museums, etc.
- Hear about upcoming events or recent news at the places you pass
- Take a real estate tour of an area, listening to previous sales and community highlights

Learn about the geology of your area as you walk over it, or narrate a coffee-focused tour of your neighborhood to share friends. Let tracks play as you go about your daily life, or follow a pre-determined walking or driving route to hear a linear story laid out in space.

## demo

### Try it

The phone on the right is the web version of the app, playing real tracks on simulated drives. When you're out on the move, open the page and your location is used to trigger nearby narration.

### Privacy

The web and iOS apps can use location determine which spots to play for you. Your location never gets sent to a Grand Tour server, and you can connect to any server you like, including one you run locally.

## create

### Creating tracks and spots

Use the web admin interface to create tracks and spots from your computer, or take a walk and narrate as you go. You can run your own server to send the content to, or export it from the iOS app.

For AI-generated content, use the Grand Tour agent skill to create anything you can dream up. 

### Serving

Anything that serves a `grandtour.json` index and the tracks it names is a GrandTour server: this site, a GitHub repository, or your own machine. You can source your tracks from anywhere you like. 

### Coming soon

- App in the iOS App store (developer mode for now)
- Android version
- CarPlay app
- Apple Watch app
- Central hub for finding and downloading / streaming tracks and spots

## opensource

### Development

GrandTour is released under the MIT license and is free to use and modify.
[gtfyi/grandtour](https://github.com/gtfyi/grandtour).

It's completely vibe-coded at the moment and fairly janky, but usable. Bug reports and feature requests appreciated as issues.

The published tracks live in [gtfyi/content](https://github.com/gtfyi/content), which is itself a GrandTour server: point the app at `github.com/gtfyi/content` and it plays them from there.
