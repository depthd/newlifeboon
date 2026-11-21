/** Изолированный стенд кузова и подвески. Один и тот же расчёт в Node и Chromium. */
import initJolt from 'jolt-physics';
import { cornerSpring, frontArm, rearArm, VIPER } from '../src/car/passport.ts';

type Jolt = Awaited<ReturnType<typeof initJolt>>;
type Vec3 = [number, number, number];
type Scenario = 'rest' | 'half-support' | 'drop-0.5m' | 'drop-2m';

const g = 9.80665;
// GTS Track Package: 1530.4 кг по спецификации SRT, плюс водитель 75 кг.
// В этой модели вся масса входит в кузов, отдельной вертикальной массы колёс нет.
const car = { ...VIPER, mass: 1605.4, unsprung: 0 };
const hull: Vec3 = [car.width / 2, car.cgHeight - 0.16, car.length / 2];
const wheels = [true, false].flatMap(front => {
  const tyre = front ? car.wheelFront : car.wheelRear;
  const arm = front ? frontArm(car) : -rearArm(car);
  const track = front ? car.trackFront : car.trackRear;
  const spring = cornerSpring(car, front);
  const max = car.suspension.ride - tyre.radius + spring.mass * g / spring.k;
  return [-1, 1].map(side => ({
    ...tyre, ...spring, position: [side * track / 2, car.suspension.ride - car.cgHeight, arm] as Vec3,
    min: max - car.suspension.travel, max,
  }));
});

function createWorld(J: Jolt) {
  const settings = new J.JoltSettings();
  const layers = new J.ObjectLayerPairFilterTable(2);
  layers.EnableCollision(0, 1);
  const broadPhase = new J.BroadPhaseLayerInterfaceTable(2, 2);
  for (const layer of [0, 1]) {
    const broadLayer = new J.BroadPhaseLayer(layer);
    broadPhase.MapObjectToBroadPhaseLayer(layer, broadLayer);
    J.destroy(broadLayer);
  }
  settings.mObjectLayerPairFilter = layers;
  settings.mBroadPhaseLayerInterface = broadPhase;
  settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(broadPhase, 2, layers, 2);
  const world = new J.JoltInterface(settings);
  J.destroy(settings);
  const system = world.GetPhysicsSystem();
  const gravity = new J.Vec3(0, -g, 0);
  system.SetGravity(gravity);
  J.destroy(gravity);
  return { world, system, bodies: system.GetBodyInterface() };
}

function measure(J: Jolt, hz: number, scenario: Scenario, broken: boolean) {
  const { world, system, bodies } = createWorld(J);
  const dt = 1 / hz;
  const rotation = new J.Quat(0, 0, 0, 1);
  function box(half: Vec3, at: Vec3, dynamic = false) {
    const dimensions = new J.Vec3(...half);
    const position = new J.RVec3(...at);
    const shape = new J.BoxShape(dimensions);
    const config = new J.BodyCreationSettings(shape, position, rotation,
      dynamic ? J.EMotionType_Dynamic : J.EMotionType_Static, dynamic ? 1 : 0);
    if (dynamic) {
      config.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
      config.mMassPropertiesOverride.mMass = car.mass;
      config.mAllowSleeping = false;
      config.mLinearDamping = 0;
      config.mAngularDamping = 0;
    }
    config.mRestitution = 0;
    const body = bodies.CreateBody(config);
    bodies.AddBody(body.GetID(), dynamic ? J.EActivation_Activate : J.EActivation_DontActivate);
    J.destroy(config);
    J.destroy(position);
    J.destroy(dimensions);
    return body;
  }

  // Половинки сходятся в x=0. Удаляем физическое тело справа, оставляя край с боковой гранью.
  const left = box([10, 0.5, 20], [-10, -0.5, 0]);
  const right = box([10, 0.5, 20], [10, -0.5, 0]);
  const chassisBody = box(hull, [0, car.cgHeight, 0], true);
  const chassis = chassisBody.GetID();
  J.destroy(rotation);

  const settings = new J.VehicleConstraintSettings();
  settings.mMaxPitchRollAngle = Math.PI;
  const controller = new J.WheeledVehicleControllerSettings();
  controller.mDifferentials.clear(); // В сценариях нет привода и торможения.
  settings.mController = controller;
  for (const wheel of wheels) {
    const config = new J.WheelSettingsWV();
    const position = new J.Vec3(...wheel.position);
    config.mPosition = position;
    J.destroy(position);
    config.mRadius = wheel.radius;
    config.mWidth = wheel.width;
    config.mInertia = wheel.inertia;
    config.mMaxSteerAngle = 0;
    config.mSuspensionMinLength = wheel.min;
    config.mSuspensionMaxLength = wheel.max;
    config.mSuspensionSpring.mMode = J.ESpringMode_StiffnessAndDamping;
    config.mSuspensionSpring.mStiffness = wheel.k;
    config.mSuspensionSpring.mDamping = wheel.c;
    settings.mWheels.push_back(config);
  }
  const vehicle = new J.VehicleConstraint(chassisBody, settings);
  vehicle.AddRef();
  J.destroy(settings);
  vehicle.SetVehicleCollisionTester(new J.VehicleCollisionTesterCastCylinder(1, 0.05));
  system.AddConstraint(vehicle);
  const listener = new J.VehicleConstraintStepListener(vehicle);
  system.AddStepListener(listener);

  const tracked = wheels.map((_, i) => vehicle.GetWheel(i));
  const xyz = (v: { GetX(): number; GetY(): number; GetZ(): number }): Vec3 => [v.GetX(), v.GetY(), v.GetZ()];
  const location = () => xyz(chassisBody.GetCenterOfMassPosition());
  const pose = () => {
    const q = chassisBody.GetRotation();
    return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()];
  };
  let removed = false;
  try {
    for (let i = 0; i < 3 * hz; i++) world.Step(dt, 1);
    const settled = location();
    const initialContacts = tracked.map(w => w.HasContact());
    const drop_m = scenario === 'drop-0.5m' ? 0.5 : scenario === 'drop-2m' ? 2 : 0;
    if (scenario === 'half-support') {
      bodies.RemoveBody(right.GetID());
      removed = true;
      if (broken) {
        const kickoff = new J.Vec3(0, 5, 0);
        bodies.SetLinearVelocity(chassis, kickoff);
        J.destroy(kickoff);
      }
    }
    if (drop_m > 0) {
      const release = new J.RVec3(settled[0], settled[1] + drop_m, settled[2]);
      const zero = new J.Vec3(0, 0, 0);
      bodies.SetPosition(chassis, release, J.EActivation_Activate);
      bodies.SetLinearAndAngularVelocity(chassis, zero, zero);
      J.destroy(zero);
      J.destroy(release);
    }
    const start = location();
    let finite = true;
    let maxDrift_m = 0, maxRise_m = 0, maxPenetration_m = 0, maxTravelExcess_m = 0;
    let minContacts = 4, finalContacts = 0, finalSpeed_mps = 0, loadError = 0;
    let peakSuspensionImpulse_Ns = 0, firstLanding_s: number | null = null;
    let firstContacts: boolean[] = [];
    const duration = scenario === 'rest' ? 30 : scenario === 'half-support' ? 2 : 5;
    for (let i = 0; i < duration * hz; i++) {
      world.Step(dt, 1);
      const position = location();
      const velocity = xyz(chassisBody.GetLinearVelocity());
      const angular = xyz(chassisBody.GetAngularVelocity());
      const lengths = tracked.map(w => w.GetSuspensionLength());
      const supported = tracked.map(w => w.HasContact());
      const impulses = tracked.map((w, j) => supported[j] ? w.GetSuspensionLambda() : 0);
      finite = [...position, ...pose(), ...velocity, ...angular, ...lengths, ...impulses,
        ...tracked.map(w => w.GetAngularVelocity())].every(Number.isFinite);
      if (!finite) break;
      const contacts = supported.filter(Boolean).length;
      if (i === 0) firstContacts = supported;
      if (drop_m > 0 && contacts > 0 && firstLanding_s === null) firstLanding_s = (i + 1) * dt;
      minContacts = Math.min(minContacts, contacts);
      finalContacts = contacts;
      finalSpeed_mps = Math.hypot(...velocity);
      maxDrift_m = Math.max(maxDrift_m, Math.hypot(...position.map((value, axis) => value - start[axis])));
      maxRise_m = Math.max(maxRise_m, position[1] - start[1]);
      maxTravelExcess_m = Math.max(maxTravelExcess_m, ...lengths.map((length, j) =>
        Math.max(wheels[j].min - length, length - wheels[j].max)));
      peakSuspensionImpulse_Ns = Math.max(peakSuspensionImpulse_Ns, ...impulses);
      if (scenario === 'rest') {
        const reaction = impulses.reduce((sum, impulse) => sum + impulse, 0) / dt;
        loadError = Math.max(loadError, Math.abs(reaction / (car.mass * g) - 1));
      }
      // На полной плоскости нижняя точка AABB коробки даёт оценку проникновения.
      if (scenario !== 'half-support') {
        maxPenetration_m = Math.max(maxPenetration_m, -chassisBody.GetWorldSpaceBounds().mMin.GetY());
      }
    }

    const limits = {
      finite,
      initialContacts: initialContacts.every(Boolean),
      travel: maxTravelExcess_m <= 0.001,
    };
    const checks = scenario === 'rest'
      ? { ...limits, fourWheels: minContacts === 4, drift: maxDrift_m <= 0.01, load: loadError <= 0.01 }
      : scenario === 'half-support'
        ? { ...limits, twoWheels: firstContacts.join() === 'true,false,true,false', noCatapult: maxRise_m <= 0.05 }
        : { ...limits, landed: minContacts === 0 && firstLanding_s !== null && finalContacts === 4,
            bounce: maxRise_m <= drop_m * 0.05, penetration: maxPenetration_m <= 0.02,
            settled: finalSpeed_mps <= 0.02 && Math.abs(location()[1] - settled[1]) <= 0.01 };
    return { hz, scenario, duration_s: duration, settledHeight_m: settled[1], firstContacts, minContacts, finalContacts,
      maxRise_m, maxDrift_m, maxTravelExcess_m, maxPenetration_m: removed ? null : maxPenetration_m,
      peakSuspensionImpulse_Ns, restLoadError_fraction: scenario === 'rest' ? loadError : null,
      firstLanding_s, finalSpeed_mps, checks };
  } finally {
    system.RemoveStepListener(listener);
    system.RemoveConstraint(vehicle);
    J.destroy(listener);
    vehicle.Release();
    for (const body of [left, right, chassisBody]) {
      if (body !== right || !removed) bodies.RemoveBody(body.GetID());
      bodies.DestroyBody(body.GetID());
    }
    J.destroy(world);
  }
}

export async function runContactStand(broken = false) {
  const J = await initJolt();
  const scenarios: Scenario[] = broken ? ['half-support'] : ['rest', 'half-support', 'drop-0.5m', 'drop-2m'];
  const rows = (broken ? [240] : [240, 480, 960]).flatMap(hz =>
    scenarios.map(scenario => measure(J, hz, scenario, broken)));
  const heights = rows.filter(row => row.scenario === 'rest').map(row => row.settledHeight_m);
  const restHeightSpread_m = broken ? null : Math.max(...heights) - Math.min(...heights);
  const passed = rows.every(row => Object.values(row.checks).every(Boolean))
    && (restHeightSpread_m === null || restHeightSpread_m <= 0.001);
  return { passed, broken, mass_kg: car.mass, restHeightSpread_m, rows };
}
