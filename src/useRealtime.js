import { useState, useEffect, useRef } from 'react';

const ALERTS_INTERVAL    = 15_000;
const TRAINS_INTERVAL    = 15_000;
const VEHICLES_INTERVAL  = 15_000;
const RIDERSHIP_INTERVAL = 300_000;
const CRIME_INTERVAL     = 86_400_000;

async function apiFetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export function useRealtime() {
  const [alerts,    setAlerts]    = useState({ byRoute: {}, list: [] });
  const [trains,    setTrains]    = useState({ counts: {}, stopVolume: {} });
  const [vehicles,  setVehicles]  = useState([]);
  const [ridership, setRidership] = useState([]);
  const [crime,     setCrime]     = useState([]);
  const [status,     setStatus]     = useState('connecting');
  const [lastUpdate, setLastUpdate] = useState(null);

  const mounted = useRef(true);

  async function fetchAlerts() {
    try {
      const data = await apiFetch('/api/alerts');
      if (!mounted.current) return;
      setAlerts(data);
      setStatus('live');
      setLastUpdate(new Date());
    } catch {
      if (mounted.current) setStatus('error');
    }
  }

  async function fetchTrains() {
    try {
      const data = await apiFetch('/api/trains');
      if (!mounted.current) return;
      setTrains(data);
    } catch {}
  }

  async function fetchVehicles() {
    try {
      const data = await apiFetch('/api/vehicles');
      if (!mounted.current) return;
      setVehicles(data);
    } catch {}
  }

  async function fetchRidership() {
    try {
      const data = await apiFetch('/api/ridership');
      if (!mounted.current) return;
      setRidership(data);
    } catch {}
  }

  async function fetchCrime() {
    try {
      const data = await apiFetch('/api/crime');
      if (!mounted.current) return;
      setCrime(data);
    } catch {}
  }

  useEffect(() => {
    mounted.current = true;
    fetchAlerts();
    fetchTrains();
    fetchVehicles();
    fetchRidership();
    fetchCrime();

    const alertTimer     = setInterval(fetchAlerts,    ALERTS_INTERVAL);
    const trainTimer     = setInterval(fetchTrains,    TRAINS_INTERVAL);
    const vehicleTimer   = setInterval(fetchVehicles,  VEHICLES_INTERVAL);
    const ridershipTimer = setInterval(fetchRidership, RIDERSHIP_INTERVAL);
    const crimeTimer     = setInterval(fetchCrime,     CRIME_INTERVAL);

    return () => {
      mounted.current = false;
      clearInterval(alertTimer);
      clearInterval(trainTimer);
      clearInterval(vehicleTimer);
      clearInterval(ridershipTimer);
      clearInterval(crimeTimer);
    };
  }, []);

  return { alerts, trains, vehicles, ridership, crime, status, lastUpdate };
}
