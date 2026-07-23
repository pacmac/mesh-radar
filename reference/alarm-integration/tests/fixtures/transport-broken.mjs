// Fixture: an implementation that exists on disk but explodes on import.
// The loader must degrade to the null object and let node-dash boot anyway —
// a broken plugin is not a reason to take the dashboard down.
throw new Error('deliberately broken fixture');
