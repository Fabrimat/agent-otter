import { Route, Routes } from 'react-router-dom';
import { AdminRoom, Home, Join, NotFound, Safety, ViewRoom } from './pages';

export const App = () => (
  <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/r" element={<AdminRoom />} />
    <Route path="/join" element={<Join />} />
    <Route path="/view" element={<ViewRoom />} />
    <Route path="/safety" element={<Safety />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);
