# tutorials:

i'd like to have a tutorial intro sequence for new games,
first we explain the interface (skippable), then, since we already have suggestions, we can build a simple tutorial that walks the player through those actions by calling out the UI, where the trade info is on the UI, that sort of thing

# fix atlas view:

the entire view scrolls instead of the panels being fixed and the contents scrolling, we need to fix this so its like the other views, fixed panels and scrollable content

station table columns should tie more into the exchange / options signals, a few from there and a few from logistics, class is not as important, focus as well, etc

ship table columns are actually pretty good for now

events are fine but clicking an event should open the events station or target if it can

the focus view for stations should be more focused on the station, not the fleet, so we can show the station's current offers and contracts, and maybe a little bit of info about the station itself, like what it produces or what it's known for

# headshot eyes

detect eye placement in headshot images, lets us scale images perfectly and center the headshots in circle UI elements

# unify the UI components

do a full audit of each view, its panels, the panel headers and tabs, the tables they contain, and any reused UI patterns

i would like you to create a new unified set of UI components to use for all future UI work, and an eventual refactor of the existing UI to use those components

they should be flexible enough to handle all the different use cases we have across the UI, but also standardized enough to create a consistent look and feel across the entire game, and make it easier and faster to build new UI in the future

if an existing UI element would need to be changed to fit into this new set of proposed components, make a note of where that might have to happen

create a new page in the UI using this new set of components, a kitchen sink page that has examples of all the different components and how they can be used, this will be a reference for future UI work and a testing ground for the new components as well

no changes to existing UI yet, just create the new components and the new page
