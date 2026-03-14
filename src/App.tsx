import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Header from '@/components/Header';
import Home from '@/pages/Home';
import Archive from '@/pages/Archive';

function App() {
  return (
    <BrowserRouter>
      <div className="bg-funky min-h-screen">
        <Header />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/archive" element={<Archive />} />
        </Routes>
        <footer className="relative z-10 text-center py-8 text-gray-500 font-body text-sm">
          <p>Made with 🔥 and questionable life choices</p>
        </footer>
      </div>
    </BrowserRouter>
  );
}

export default App;
