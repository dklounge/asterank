$(function() {
  "use strict";

  window.requestAnimFrame = (function(){
    return  window.requestAnimationFrame       ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame    ||
            window.oRequestAnimationFrame      ||
            window.msRequestAnimationFrame     ||
            function( callback ){
              window.setTimeout(callback, 1000 / 60);
            };
  })();


  var WEB_GL_ENABLED = true;

  var MAX_NUM_ORBITS = 4000;
  var CANVAS_NUM_ORBITS = 30;  // gimped version orbits
  var PIXELS_PER_AU = 50;
  var NUM_BIG_PARTICLES = 25;   // show this many asteroids with orbits

  var stats, scene, renderer, composer;
  var camera, cameraControls;
  var pi = Math.PI;
  var using_webgl = false;
  var camera_fly_around = true;
  var object_movement_on = true;
  var lastHovered;
  var added_objects = [];
  var planets = [];
  var planet_orbits_visible = true;
  var jed = toJED(new Date());
  var particle_system_geometry = null;
  var asteroids_loaded = false;
  var display_date_last_updated = 0;

  // Lock/feature stuff
  var feature_map = {};       // map from object full name to Orbit3D instance
  var locked_object = null;
  var locked_object_ellipse = null;
  var locked_object_idx = -1;
  var locked_object_size = -1;

  // workers stuff
  var works = [];
  var workers = [];
  var NUM_WORKERS = 3;
  var worker_path = '/3d/js/position_worker.js';
  var workers_initialized = false;
  var particleSystem;

  // glsl stuff
  var attributes;
  var uniforms;
  var psg_vertex_offset;

  init();
  initGUI();

  $('#btn-toggle-movement').on('click', function() {
    object_movement_on = !object_movement_on;
  });
  $('#controls .js-sort').on('click', function() {
    runAsteroidQuery($(this).data('sort'));
    $('#controls .js-sort').css('font-weight', 'normal');
    $(this).css('font-weight', 'bold');
  });

  function initGUI() {
    var ViewUI = function() {
      this['Cost effective'] = function() {
        runAsteroidQuery('score');
      };
      this['Most valuable'] = function() {
        runAsteroidQuery('price');
      };
      this['Most accessible'] = function() {
        runAsteroidQuery('closeness');
      };
      this.movement = object_movement_on;
      this['planet orbits'] = planet_orbits_visible;
      this['display date'] = '12/26/2012';
    };

    window.onload = function() {
      var text = new ViewUI();
      var gui = new dat.GUI();
      gui.add(text, 'Cost effective');
      gui.add(text, 'Most valuable');
      gui.add(text, 'Most accessible');
      gui.add(text, 'movement').onChange(function() {
        object_movement_on = !object_movement_on;
        toggleSimulation(object_movement_on);
      });
      gui.add(text, 'planet orbits').onChange(function() {
        togglePlanetOrbits();
      });
      gui.add(text, 'display date').onChange(function(val) {
        // TODO don't do anything unless it changed
        var newdate = Date.parse(val);
        if (newdate) {
          var newjed = toJED(newdate);
          changeJED(newjed);
        }
      }).listen();
      window.datgui = text;
    }; // end window onload
  }

  function togglePlanetOrbits() {
    if (planet_orbits_visible) {
      for (var i=0; i < planets.length; i++) {
        scene.remove(planets[i].getEllipse());
      }
    }
    else {
      for (var i=0; i < planets.length; i++) {
        scene.add(planets[i].getEllipse());
      }
    }
    planet_orbits_visible = !planet_orbits_visible;
  }

  // init the scene
  function init(){
    $('#loading-text').html('renderer');
    if (WEB_GL_ENABLED && Detector.webgl){
      renderer = new THREE.WebGLRenderer({
        antialias		: true,	// to get smoother output
        //preserveDrawingBuffer	: true	// to allow screenshot
      });
      renderer.setClearColor(0x000000, 1);
      using_webgl = true;
      window.gl = renderer.getContext();
    }
    else {
      renderer	= new THREE.CanvasRenderer();
      $('#not-supported').show();
      if (typeof mixpanel !== 'undefined') mixpanel.track('not supported');
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('container').appendChild(renderer.domElement);

    /*
    // Set up stats
    stats = new Stats();
    stats.domElement.style.position	= 'absolute';
    stats.domElement.style.bottom	= '0px';
    document.body.appendChild(stats.domElement);
    */

    // create a scene
    scene = new THREE.Scene();

    // put a camera in the scene
    var cameraH	= 3;
    var cameraW	= cameraH / window.innerHeight * window.innerWidth;
    window.cam = camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 5000);
    setDefaultCameraPosition();
    //camera.position.set(22.39102192510384, -124.78460848134833, -55.29382439584528);
    //camera.position.set(12.39102192510384, -124.78460848134833, -75.29382439584528);

    //camera.position.set(-145, 41, -31);
    // 77, -155, 23

    THREE.Object3D._threexDomEvent.camera(camera);    // camera mouse handler
    THREEx.WindowResize(renderer, camera);    // handle window resize

    scene.add(camera);

    cameraControls	= new THREE.TrackballControlsX(camera)
    cameraControls.staticMoving = true;
    cameraControls.panSpeed = 2;
    cameraControls.zoomSpeed = 3;
    cameraControls.maxDistance = 1100;

    // Rendering stuff

    // "sun" - 0,0 marker
    if (using_webgl) {
      $('#loading-text').html('sun');
      var sun = new THREE.Object3D();
      var texture = THREE.ImageUtils.loadTexture("/images/sunsprite.png");
      var sprite = new THREE.Sprite({
        map: texture,
        blending: THREE.AdditiveBlending,
        useScreenCoordinates: false,
        color: 0xffffff
      });
      sprite.scale.x = 50;
      sprite.scale.y = 50;
      sprite.scale.z = 1;
      sprite.color.setHSV(1.0, 0.0, 1.0);
      sun.add(sprite);
      scene.add(sun);
    }
    else {
      var material = new THREE.ParticleBasicMaterial({
        map: new THREE.Texture( starTexture(0xfff2a1,1) ),
        blending: THREE.AdditiveBlending
      });
      var particle = new THREE.Particle(material);
      particle.isClickable = false;
      scene.add(particle);
    }

    /*
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(75, 75), new THREE.MeshBasicMaterial({
        color: 0x0000ff
    }));
    plane.overdraw = true;
    plane.doubleSided = true;
    plane.rotation.x = pi/2;
    scene.add(plane);
    */

    // Ellipses
    runAsteroidQuery();

      $('#loading-text').html('planets');
    var mercury = new Orbit3D(Ephemeris.mercury,
        {
          color: 0x913CEE, width: 1, jed: jed, object_size: 1.7,
          texture_path: '/images/texture-mercury.jpg',
          display_color: new THREE.Color(0x913CEE),
          particle_geometry: particle_system_geometry
        }, !using_webgl);
    scene.add(mercury.getEllipse());
    if (!using_webgl)
      scene.add(mercury.getParticle());
    var venus = new Orbit3D(Ephemeris.venus,
        {
          color: 0xFF7733, width: 1, jed: jed, object_size: 1.7,
          texture_path: '/images/texture-venus.jpg',
          display_color: new THREE.Color(0xFF7733),
          particle_geometry: particle_system_geometry
        }, !using_webgl);
    scene.add(venus.getEllipse());
    if (!using_webgl)
      scene.add(venus.getParticle());
    var earth = new Orbit3D(Ephemeris.earth,
        {
          color: 0x009ACD, width: 1, jed: jed, object_size: 1.7,
          texture_path: '/images/texture-earth.jpg',
          display_color: new THREE.Color(0x009ACD),
          particle_geometry: particle_system_geometry
        }, !using_webgl);
    scene.add(earth.getEllipse());
    if (!using_webgl)
      scene.add(earth.getParticle());
    var mars = new Orbit3D(Ephemeris.mars,
        {
          color: 0xA63A3A, width: 1, jed: jed, object_size: 1.7,
          texture_path: '/images/texture-mars.jpg',
          display_color: new THREE.Color(0xA63A3A),
          particle_geometry: particle_system_geometry
        }, !using_webgl);
    scene.add(mars.getEllipse());
    if (!using_webgl)
      scene.add(mars.getParticle());
    var jupiter = new Orbit3D(Ephemeris.jupiter,
        {
          color: 0xFF7F50, width: 1, jed: jed, object_size: 1.7,
          texture_path: '/images/texture-jupiter.jpg',
          display_color: new THREE.Color(0xFF7F50),
          particle_geometry: particle_system_geometry
        }, !using_webgl);
    scene.add(jupiter.getEllipse());
    if (!using_webgl)
      scene.add(jupiter.getParticle());

    planets = [mercury, venus, earth, mars, jupiter];

    // Sky
    if (using_webgl) {
      $('#loading-text').html('skybox');
      var path = "/images/dark-s_";
      var format = '.jpg';
      var urls = [
          path + 'px' + format, path + 'nx' + format,
          path + 'py' + format, path + 'ny' + format,
          path + 'pz' + format, path + 'nz' + format
        ];
      var reflectionCube = THREE.ImageUtils.loadTextureCube( urls );
      reflectionCube.format = THREE.RGBFormat;

      var shader = THREE.ShaderUtils.lib[ "cube" ];
      shader.uniforms[ "tCube" ].value = reflectionCube;

      var material = new THREE.ShaderMaterial( {
        fragmentShader: shader.fragmentShader,
        vertexShader: shader.vertexShader,
        uniforms: shader.uniforms,
        depthWrite: false,
        side: THREE.BackSide
      } ),

      mesh = new THREE.Mesh( new THREE.CubeGeometry( 5000, 5000, 5000 ), material );
      scene.add(mesh);
    }

    $('#container').on('mousedown', function() {
      camera_fly_around = false;
    });

    window.renderer = renderer;
  }

  // animation loop
  function animate() {
    if (!asteroids_loaded) {
      render();
      requestAnimFrame(animate);
      return;
    }

    if (camera_fly_around) {
      if (locked_object) {
        // Follow locked object
        var pos = locked_object.getPosAtTime(jed);
        cam.position.set(pos[0]+50, pos[1]+50, pos[2]+50);
        cameraControls.target = new THREE.Vector3(pos[0], pos[1], pos[2]);
      }
      else {
        setNeutralCameraPosition();
      }
    }

    render();
    requestAnimFrame(animate);
  }

  function setNeutralCameraPosition() {
    // Follow floating path around
    var timer = 0.0001 * Date.now();
    cam.position.x = Math.sin(timer) * 10;
    //cam.position.y = Math.sin( timer ) * 100;
    cam.position.z = -100 + Math.cos(timer) * 20;
  }

  // camera locking fns
  function clearLock(set_default_camera) {
    if (!locked_object) return;

    if (set_default_camera)
      setDefaultCameraPosition();

    cameraControls.target = new THREE.Vector3(0,0,0);

    // restore color and size
    var idx = locked_object_idx - psg_vertex_offset;
    if (using_webgl) {
      attributes.value_color.value[idx] =
        //displayColorForObject(locked_object);
        new THREE.Color(0xffff00);
      attributes.size.value[idx] = locked_object_size;
      attributes.locked.value[idx] = 0.0;
    }
    scene.remove(locked_object_ellipse);

    locked_object = null;
    locked_object_ellipse = null;
    locked_object_idx = -1;
    locked_object_size = -1;

    // reset camera pos so subsequent locks don't get into crazy positions
    setNeutralCameraPosition();
  }
  function setLock(full_name) {
    if (locked_object) {
      clearLock();
    }

    var mapped_obj = feature_map[full_name];
    var orbit_obj = mapped_obj['orbit'];
    if (!orbit_obj) {
      alert("Sorry, something went wrong and I can't lock on this object.");
      return;
    }
    locked_object = orbit_obj;
    locked_object_idx = mapped_obj['idx']; // this is the object's position in the added_objects array
    var idx = locked_object_idx - psg_vertex_offset;

    if (using_webgl) {
      attributes.value_color.value[idx] = new THREE.Color(0xff0000);
      locked_object_size = attributes.size.value[idx];
      attributes.size.value[idx] = 30.0;
      attributes.locked.value[idx] = 1.0;
    }

    locked_object_ellipse = locked_object.getEllipse();
    scene.add(locked_object_ellipse);
    camera_fly_around = true;
  }

  // render the scene
  function render() {
    // update camera controls
    cameraControls.update();

    // update display date
    var now = new Date().getTime();
    if (now - display_date_last_updated > 500 && typeof datgui !== 'undefined') {
      var georgian_date = fromJED(jed);
      datgui['display date'] = georgian_date.getMonth()+1 + "/"
        + georgian_date.getDate() + "/" + georgian_date.getFullYear();
      display_date_last_updated = now;
    }

    if (using_webgl && object_movement_on) {
      // update shader vals for asteroid cloud
      uniforms.jed.value = jed;
      jed += .25;
    }

    // actually render the scene
    renderer.render(scene, camera);
  }

  function startSimulation() {
    if (!asteroids_loaded) {
      throw "couldn't start simulation: asteroids not loaded";
    }
    if (!workers_initialized) {
      throw "couldn't start simulation: simulation not initialized";
    }

    for (var i=0; i < workers.length; i++) {
      // trigger work
      var particles = works[i];
      var obj_ephs = [];
      for (var j=0; j < particles.length; j++) {
        obj_ephs.push(particles[j].eph);
      }
      workers[i].postMessage({
        command: 'start',
        particle_ephemeris: obj_ephs,
        start_jed: jed
      });
    }
  }

  function stopSimulation() {
    toggleSimulation(false);
  }

  function toggleSimulation(run) {
    for (var i=0; i < workers.length; i++) {
      workers[i].postMessage({
        command: 'toggle_simulation',
        val: run
      });
    }
  }

  function initSimulation() {
    var l = added_objects.length;
    var objects_per_worker = Math.ceil(l / NUM_WORKERS);
    var remainder = l % NUM_WORKERS;
    for (var i=0; i < NUM_WORKERS; i++) {
      workers[i] = new Worker(worker_path);
      var start = i*objects_per_worker;
      works[i] = added_objects.slice(start, Math.min(start + objects_per_worker, l));
    }

    $.each(works, function(idx) {
      var work = this;
      workers[idx].onmessage = function(e) {
        handleSimulationResults(e, work.slice());
      }
    });
    /*
    for (var i=0; i < NUM_WORKERS; i++) {
      (function() {
        workers[i].onmessage = function(e) {
          handleSimulationResults(e, works[i]);
        }
      })();
    }
    */
    workers_initialized = true;
  }

  function handleSimulationResults(e, particles) {
    var data = e.data;
    switch(data.type) {
      case 'result':
        // queue simulation results
        var positions = data.value.positions;

        for (var i=0; i < positions.length; i++) {
          particles[i].MoveParticleToPosition(positions[i]);
        }

        if (typeof datgui !== 'undefined') {
          // update with date
          var now = new Date().getTime();
          if (now - display_date_last_updated > 500) {
            var georgian_date = fromJED(data.value.jed);
            datgui['display date'] = georgian_date.getMonth()+1 + "/"
              + georgian_date.getDate() + "/" + georgian_date.getFullYear();
            display_date_last_updated = now;
          }
        }
        break;
      case 'debug':
        console.log(data.value);
        break;
      default:
        console.log('Invalid data type', data.type);
    }
  }


  function runAsteroidQuery(sort) {
    sort = sort || 'score';
    $('#loading').show();

    // Remove any old setup
    for (var i=0; i < added_objects.length; i++) {
      scene.remove(added_objects[i].getParticle());
    }
    clearLock(true);
    if (particleSystem) {
      scene.remove(particleSystem);
      particleSystem = null;
    }
    if (asteroids_loaded) {
      stopSimulation();
    }

    if (lastHovered) {
      scene.remove(lastHovered);
    }

    // Get new data points
    $('#loading-text').html('asteroids database');
    $.getJSON('/top?sort=' + sort + '&n='
        + (using_webgl ? MAX_NUM_ORBITS : CANVAS_NUM_ORBITS)
        + '&use3d=true&compact=true', function(data) {
      if (!data.results) {
        alert('Sorry, something went wrong and the server failed to return data.');
        return;
      }
      var n = data.results.rankings.length;
      // add planets
      added_objects = planets.slice();
      particle_system_geometry = new THREE.Geometry();

      var useBigParticles = !using_webgl;
      var featured_count = 0;
      var featured_html = '';
      for (var i=0; i < n; i++) {
        if (i === NUM_BIG_PARTICLES) {
          if (!using_webgl) {
            // only show objects of interest if there's no particlesystem support
            break;
          }
          useBigParticles = false;
        }
        var roid_data = data.results.rankings[i];
        var roid = {};
        for (var j=0; j < data.results.fields.length; j++) {
          roid[data.results.fields[j]] = roid_data[j];
        }
        var locked = false;
        var orbit = new Orbit3D(roid, {
          color: 0xcccccc,
          display_color: displayColorForObject(roid),
          width: 2,
          object_size: 1.5,
          jed: jed,
          particle_geometry: particle_system_geometry // will add itself to this geometry
        }, useBigParticles);
        if (useBigParticles) {
          // bind information/orbit mouseover - only for canvas mode
          (function(roid, orbit, i) {
            orbit.getParticle().on('mouseover', function(e) {
              if (lastHovered) scene.remove(lastHovered);
              lastHovered = orbit.getEllipse();
              scene.add(lastHovered);
              if (roid.price < 1e10) {
                $('#main-caption').html(roid.full_name + ' - no significant value');
              }
              else {
                $('#main-caption').html(roid.full_name
                      + ' - $' + roid.fuzzed_price + ' in potential value');
              }
              $('#other-caption').html('(ranked #' + (i+1) + ')');
            });
          })(roid, orbit, i);
            var particle_to_add = orbit.getParticle();
          scene.add(particle_to_add);
        } // end bigParticle logic

        if (featured_count++ < 30) {
          // Add it to featured list
          feature_map[roid.full_name] = {
            'orbit': orbit,
            'idx': added_objects.length
          };
          featured_html += '<tr data-full-name="'
            + roid.full_name
            + '"><td><a href="#">'
            + (roid.prov_des || roid.full_name)
            + '</a></td><td>'
            + (roid.price < 1 ? 'N/A' : '$' + roid.fuzzed_price)
            + '</td></tr>';
        }

        // Add to list of objects in scene
        added_objects.push(orbit);
      } // end asteroid results for loop

      // handle when view mode is switched - need to clear every row but the sun
      $('#objects-of-interest tr:not(:first)').remove();
      $('#objects-of-interest').append(featured_html).on('click', 'tr', function() {
        $('#objects-of-interest tr').css('background-color', '#000');
        var $e = $(this);
        var full_name = $e.data('full-name');
        $('#sun-selector').css('background-color', 'green');
        switch (full_name) {
          // special case full names
          case 'sun':
            clearLock(true);
            return false;
        }
        clearLock();

        // set new lock
        $e.css('background-color', 'green');
        $('#sun-selector').css('background-color', '#000');
        setLock(full_name);

        return false;
      });
      $('#objects-of-interest-container').show();

      asteroids_loaded = true;
      if (using_webgl) {
        createParticleSystem();
      }
      else {
        initSimulation();
        startSimulation();
      }

      console.log('Starting with', NUM_WORKERS, 'workers for', n, 'from request of', MAX_NUM_ORBITS);

      animate();

      $('#loading').hide();

      if (typeof mixpanel !== 'undefined') mixpanel.track('simulation started');
    });
  }

  function createParticleSystem() {
    // attributes
    attributes = {
      a: { type: 'f', value: [] },
      e: { type: 'f', value: [] },
      i: { type: 'f', value: [] },
      o: { type: 'f', value: [] },
      ma: { type: 'f', value: [] },
      n: { type: 'f', value: [] },
      w: { type: 'f', value: [] },
      P: { type: 'f', value: [] },
      epoch: { type: 'f', value: [] },
      value_color : { type: 'c', value: [] },
      size: { type: 'f', value: [] },
      locked: { type: 'f', value: [] }  // attributes can't be bool or int in some versions of opengl
    };

    uniforms = {
      color: { type: "c", value: new THREE.Color( 0xffffff ) },
      jed: { type: 'f', value: jed },
      earth_i: { type: "f", value: Ephemeris.earth.i },
      earth_om: { type: "f", value: Ephemeris.earth.om },
      small_roid_texture:
        { type: "t", value: THREE.ImageUtils.loadTexture("/images/cloud4.png") },
      small_roid_circled_texture:
        { type: "t", value: THREE.ImageUtils.loadTexture("/images/cloud4-circled.png") }
    };
    var vertexshader = document.getElementById( 'vertexshader' ).textContent
                          .replace('{{PIXELS_PER_AU}}', PIXELS_PER_AU.toFixed(1));
    var particle_system_shader_material = new THREE.ShaderMaterial( {
      uniforms:       uniforms,
      attributes:     attributes,
      vertexShader:   vertexshader,
      fragmentShader: document.getElementById( 'fragmentshader' ).textContent,
    });
    particle_system_shader_material.depthTest = false;
    particle_system_shader_material.vertexColor = true;
    particle_system_shader_material.transparent = true;
    particle_system_shader_material.blending = THREE.AdditiveBlending;

    psg_vertex_offset = 0;//added_objects.length - particle_system_geometry.vertices.length;
    for( var i = 0; i < particle_system_geometry.vertices.length; i++ ) {
      var added_objects_idx = i + psg_vertex_offset;

      attributes.size.value[i] = i < 30 ? 50 : 15;

      attributes.a.value[i] = added_objects[added_objects_idx].eph.a;
      attributes.e.value[i] = added_objects[added_objects_idx].eph.e;
      attributes.i.value[i] = added_objects[added_objects_idx].eph.i;
      attributes.o.value[i] = added_objects[added_objects_idx].eph.om;
      attributes.ma.value[i] = added_objects[added_objects_idx].eph.ma;
      attributes.n.value[i] = added_objects[added_objects_idx].eph.n || -1.0;
      attributes.w.value[i] = added_objects[added_objects_idx].eph.w;
      attributes.P.value[i] = added_objects[added_objects_idx].eph.P || -1.0;
      attributes.epoch.value[i] = added_objects[added_objects_idx].eph.epoch;
      // http://threejsdoc.appspot.com/doc/three.js/examples.source/webgl_custom_attributes_lines.html.html
      attributes.value_color.value[i] = added_objects[added_objects_idx].opts.display_color;
      attributes.locked.value[i] = 0.0;
    }

    particleSystem = new THREE.ParticleSystem(
      particle_system_geometry,
      //particle_system_material
      particle_system_shader_material
    );
    window.ps = particleSystem;

    // add it to the scene
    particleSystem.sortParticles = true;
    scene.add(particleSystem);
  }

  function starTexture(color, size) {
    var size = (size) ? parseInt(size*24) : 24;
    var canvas = document.createElement( 'canvas' );
    canvas.width = size;
    canvas.height = size;
    var col = new THREE.Color(color);

    var context = canvas.getContext( '2d' );
    var gradient = context.createRadialGradient( canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width / 2 );
    var rgbaString = 'rgba(' + ~~ ( col.r * 255 ) + ',' + ~~ ( col.g * 255 ) + ',' + ~~ ( col.b * 255 ) + ',' + (1) + ')';
    gradient.addColorStop( 0, rgbaString);
    gradient.addColorStop( 0.1, rgbaString);
    gradient.addColorStop( 0.6, 'rgba(125, 20, 0, 0.2)' );
    gradient.addColorStop( .92, 'rgba(0,0,0,0)' );
    context.fillStyle = gradient;
    context.fillRect( 0, 0, canvas.width, canvas.height );
    return canvas;
  }

  function changeJED(new_jed) {
    jed = new_jed;
    /*
    for (var i=0; i < workers.length; i++) {
      workers[i].postMessage({
        command: 'set_jed',
        jed: new_jed
      });
    }
    */
  }

  function setDefaultCameraPosition() {
    cam.position.set(0, -155, 32);
  }
});
if (!window.console) window.console = {log: function() {}};
