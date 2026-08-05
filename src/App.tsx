import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Header from '@/components/Header';
import Home from '@/pages/Home';
import Archive from '@/pages/Archive';
import { AuthProvider } from '@/contexts/AuthContext';
import { ProgressProvider } from '@/contexts/ProgressContext';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ProgressProvider>
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
        </ProgressProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
